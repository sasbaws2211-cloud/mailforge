# frozen_string_literal: true

require "test_helper"

class ClientTest < Minitest::Test
  def setup
    @waited = []
    ENV.delete("LOOMAIL_SECRET_KEY")
    ENV.delete("LOOMAIL_HOST")
  end

  def client(transport, **extra)
    Loomail::Client.new(secret_key: "mf_live_test", host: "https://loomail.test/", transport: transport,
                        sleeper: ->(s) { @waited << s }, **extra)
  end

  def assert_error(code)
    error = assert_raises(Loomail::Error) { yield }
    assert_equal code, error.code, error.message
    error
  end

  def test_identify_sends_bearer_key_traits_and_generated_message_id
    t = FakeTransport.new
    client(t).identify("u1", { email: "a@b.c", plan: "trial" })
    r = t.requests.first
    assert_equal "https://loomail.test/v1/identify", r.url
    assert_equal "Bearer mf_live_test", r.headers["Authorization"]
    assert_equal "application/json", r.headers["Content-Type"]
    assert_equal "u1", r.json["userId"]
    assert_equal({ "email" => "a@b.c", "plan" => "trial" }, r.json["traits"])
    assert_match(/\A[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}\z/, r.json["messageId"])
    refute r.json.key?("timestamp")
    refute r.json.key?("context")
  end

  def test_traits_and_properties_may_be_plain_keywords_with_options_kept_apart
    t = FakeTransport.new
    c = client(t)
    c.identify("u1", email: "a@b.c", plan: "trial", message_id: "m1")
    c.identify("u1", { plan: "pro" }, email: "x@y.z", timestamp: Time.utc(2026, 5, 1))
    c.track("u1", "paid", amount: 4900, context: { ip: "1.2.3.4" })
    assert_equal({ "email" => "a@b.c", "plan" => "trial" }, t.requests[0].json["traits"])
    assert_equal "m1", t.requests[0].json["messageId"]
    assert_equal({ "plan" => "pro", "email" => "x@y.z" }, t.requests[1].json["traits"])
    assert_equal "2026-05-01T00:00:00.000Z", t.requests[1].json["timestamp"]
    assert_equal({ "amount" => 4900 }, t.requests[2].json["properties"])
    assert_equal({ "ip" => "1.2.3.4" }, t.requests[2].json["context"])
  end

  def test_empty_traits_and_properties_are_objects
    t = FakeTransport.new
    c = client(t)
    c.identify("u1")
    c.track("u1", "e")
    assert_includes t.requests[0].body, '"traits":{}'
    assert_includes t.requests[1].body, '"properties":{}'
  end

  def test_track_sends_properties_context_and_utc_timestamp_from_any_zone
    t = FakeTransport.new
    when_ = Time.new(2026, 5, 1, 12, 0, 0, "+02:00") # 10:00 UTC
    client(t).track("u1", "paid", { amount: 4900 }, timestamp: when_, context: { ip: "1.2.3.4" })
    j = t.requests.first.json
    assert_equal "2026-05-01T10:00:00.000Z", j["timestamp"]
    assert_equal "paid", j["event"]
    assert_equal 4900, j["properties"]["amount"]
    assert_equal "1.2.3.4", j["context"]["ip"]
    client(t).track("u1", "e", {}, timestamp: "2026-05-01T10:00:00+02:00")
    assert_equal "2026-05-01T08:00:00.000Z", t.requests.last.json["timestamp"]
  end

  def test_own_message_id_and_deduplicated_repeat
    t = FakeTransport.new(FakeTransport.json(200, { success: true, deduplicated: true }))
    r = client(t).track("u1", "paid", {}, message_id: "paid:inv_9")
    assert_equal "paid:inv_9", t.requests.first.json["messageId"]
    assert r.deduplicated?
    refute client(FakeTransport.new).track("u1", "e").deduplicated?
  end

  def test_rejects_bad_arguments_before_any_request
    t = FakeTransport.new
    c = client(t)
    assert_error(:invalid_argument) { c.identify("  ") }
    assert_error(:invalid_argument) { c.identify(nil) }
    assert_error(:invalid_argument) { c.track("u1", "") }
    assert_error(:invalid_argument) { c.track("u1", "e", {}, timestamp: "not a date") }
    assert_error(:invalid_argument) { c.track("u1", "e", { bad: "\xB1\x31".b.force_encoding("UTF-8") }) }
    assert_empty t.requests
  end

  def test_refuses_a_missing_or_publishable_key
    assert_error(:invalid_argument) { Loomail::Client.new }
    error = assert_error(:invalid_argument) { Loomail::Client.new(secret_key: "mf_pub_abc") }
    assert_includes error.message, "publishable"
  end

  def test_host_and_key_from_environment
    ENV["LOOMAIL_SECRET_KEY"] = "mf_live_env"
    ENV["LOOMAIL_HOST"] = "https://loomail.example.com///"
    t = FakeTransport.new
    Loomail::Client.new(transport: t).track("u1", "e")
    assert_equal "https://loomail.example.com/v1/track", t.requests.first.url
    assert_equal "Bearer mf_live_env", t.requests.first.headers["Authorization"]
    ENV.delete("LOOMAIL_HOST")
    t2 = FakeTransport.new
    Loomail::Client.new(transport: t2).track("u1", "e")
    assert_equal "https://loomail.site/v1/track", t2.requests.first.url
  ensure
    ENV.delete("LOOMAIL_SECRET_KEY")
  end

  def test_retries_a_503_with_the_same_message_id_then_succeeds
    t = FakeTransport.new(FakeTransport.json(503, { error: "busy" }), [503, {}, "<html>"], FakeTransport.json(200, { success: true }))
    client(t).track("u1", "e")
    assert_equal 3, t.requests.length
    assert_equal 1, t.requests.map { |r| r.json["messageId"] }.uniq.length
    assert_equal 2, @waited.length
    assert_operator @waited[0], :>=, 0.5
    assert_operator @waited[1], :>=, 1.0
  end

  def test_honours_retry_after
    t = FakeTransport.new(FakeTransport.json(429, { error: "slow" }, { "retry-after" => "7" }), FakeTransport.json(200, {}))
    client(t).track("u1", "e")
    assert_equal [7.0], @waited
  end

  def test_gives_up_after_max_retries_and_says_why
    t = FakeTransport.new(FakeTransport.json(429, { error: "too many" }))
    error = assert_error(:rate_limited) { client(t, max_retries: 2).track("u1", "e") }
    assert_equal 429, error.status
    assert_equal({ "error" => "too many" }, error.body)
    assert_includes error.message, "too many"
    assert_equal 3, t.requests.length

    t2 = FakeTransport.new([500, {}, ""])
    assert_error(:server) { client(t2, max_retries: 0).track("u1", "e") }
    assert_equal 1, t2.requests.length
  end

  def test_does_not_retry_a_mistake
    { 401 => :unauthorized, 402 => :plan_limit, 403 => :forbidden, 400 => :validation, 422 => :validation }.each do |status, code|
      t = FakeTransport.new(FakeTransport.json(status, { error: "no" }))
      assert_error(code) { client(t).track("u1", "e") }
      assert_equal 1, t.requests.length, "status #{status}"
    end
  end

  def test_network_failure_is_retried_then_reported
    t = FakeTransport.new(Loomail::Client::TransportError.new("Connection refused"))
    error = assert_error(:network) { client(t, max_retries: 1).track("u1", "e") }
    assert_includes error.message, "Connection refused"
    assert_equal 2, t.requests.length
  end

  def test_batch_splits_into_requests_of_100_and_offsets_error_indexes
    t = FakeTransport.new(
      FakeTransport.json(200, { received: 100 }),
      FakeTransport.json(200, { received: 99, errors: [{ index: 3, message: "at limit", code: "plan_limit" }] }),
      FakeTransport.json(200, { received: 50 })
    )
    items = Array.new(250) do |i|
      i.even? ? { type: :identify, user_id: "u#{i}", traits: { n: i } } : { type: "track", user_id: "u#{i}", event: "e" }
    end
    result = client(t).batch(items)
    assert_equal 3, t.requests.length
    assert_equal "https://loomail.test/v1/batch", t.requests[0].url
    assert_equal [100, 100, 50], t.requests.map { |r| r.json["batch"].length }
    first = t.requests[0].json["batch"][0]
    assert_equal "identify", first["type"]
    assert_equal "u0", first["userId"]
    assert_equal 249, result.received
    assert_equal [{ index: 103, message: "at limit", code: "plan_limit" }], result.errors
  end

  def test_batch_rejects_a_bad_item_before_sending_anything
    t = FakeTransport.new
    error = assert_error(:invalid_argument) do
      client(t).batch([{ type: :identify, user_id: "u1" }, { type: :track, user_id: "u2", event: "" }])
    end
    assert_includes error.message, "batch[1]"
    assert_error(:invalid_argument) { client(t).batch([{ type: :nope, user_id: "u" }]) }
    assert_empty t.requests
  end

  def test_batch_splits_on_size_too
    t = FakeTransport.new(FakeTransport.json(200, { received: 1 }))
    big = "x" * (120 * 1024)
    items = %w[a b c d].map { |u| { type: :track, user_id: u, event: "e", properties: { p: big } } }
    client(t).batch(items)
    assert_operator t.requests.length, :>=, 2
    t.requests.each { |r| assert_operator r.body.bytesize, :<, 512 * 1024 }
  end

  def test_timeout_is_passed_to_the_transport
    t = FakeTransport.new
    client(t, timeout: 2.5).track("u1", "e")
    assert_equal 2.5, t.requests.first.timeout
  end
end
