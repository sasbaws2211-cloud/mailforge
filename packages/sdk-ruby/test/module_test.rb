# frozen_string_literal: true

require "test_helper"

class ModuleTest < Minitest::Test
  def setup
    Loomail.reset!
    ENV.delete("LOOMAIL_SECRET_KEY")
    ENV.delete("LOOMAIL_HOST")
  end

  def teardown
    Loomail.reset!
  end

  def test_configure_builds_the_shared_client_and_delegators_use_it
    t = FakeTransport.new
    Loomail.configure do |c|
      c.secret_key = "mf_live_cfg"
      c.host = "https://loomail.example.com"
      c.timeout = 3
      c.max_retries = 1
    end
    Loomail.client.instance_variable_set(:@transport, t)
    Loomail.identify("u1", email: "a@b.c")
    Loomail.track("u1", "signed_up", { source: "ads" }, message_id: "m1")
    Loomail.batch([{ type: :track, user_id: "u1", event: "e" }])
    assert_equal %w[https://loomail.example.com/v1/identify https://loomail.example.com/v1/track https://loomail.example.com/v1/batch], t.requests.map(&:url)
    assert_equal({ "email" => "a@b.c" }, t.requests[0].json["traits"])
    assert_equal "m1", t.requests[1].json["messageId"]
    assert_equal 3.0, t.requests[0].timeout
    assert_same Loomail.client, Loomail.client
  end

  def test_reconfiguring_replaces_the_client
    Loomail.configure { |c| c.secret_key = "mf_live_one" }
    first = Loomail.client
    Loomail.configure { |c| c.secret_key = "mf_live_two" }
    refute_same first, Loomail.client
  end

  def test_falls_back_to_the_environment
    ENV["LOOMAIL_SECRET_KEY"] = "mf_live_env"
    t = FakeTransport.new
    Loomail.client = Loomail::Client.new(transport: t)
    Loomail.track("u1", "e")
    assert_equal "Bearer mf_live_env", t.requests.first.headers["Authorization"]
  ensure
    ENV.delete("LOOMAIL_SECRET_KEY")
  end

  def test_a_missing_key_fails_clearly_on_first_use
    error = assert_raises(Loomail::Error) { Loomail.track("u1", "e") }
    assert_equal :invalid_argument, error.code
  end

  def test_later_calls_straight_away_without_active_job
    refute defined?(::ActiveJob), "this process must not have loaded ActiveJob"
    t = FakeTransport.new
    Loomail.client = Loomail::Client.new(secret_key: "mf_live_x", transport: t)
    Loomail.track_later("u1", "e", { a: 1 }, timestamp: Time.utc(2026, 5, 1, 10))
    Loomail.identify_later("u1", { plan: "pro" })
    assert_equal 2, t.requests.length
    assert_equal "2026-05-01T10:00:00.000Z", t.requests[0].json["timestamp"]
    refute_nil t.requests[0].json["messageId"]
  end
end
