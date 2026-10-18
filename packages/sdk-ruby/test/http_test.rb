# frozen_string_literal: true

require "test_helper"
require "webrick"

# The default transport (Net::HTTP) against a real local web server.
class HttpTest < Minitest::Test
  def setup
    ENV.delete("LOOMAIL_SECRET_KEY")
    @seen = []
    @server = WEBrick::HTTPServer.new(Port: 0, BindAddress: "127.0.0.1", Logger: WEBrick::Log.new(File::NULL), AccessLog: [])
    @server.mount_proc("/echo/v1/track") do |req, res|
      @seen << { auth: req["authorization"], ct: req["content-type"], ua: req["user-agent"], body: JSON.parse(req.body) }
      res["Content-Type"] = "application/json"
      res.body = '{"success":true,"deduplicated":true}'
    end
    @server.mount_proc("/slow/v1/track") { |_req, res| sleep 1.0; res.body = "{}" }
    @server.mount_proc("/limit/v1/track") do |_req, res|
      res.status = 402
      res.body = '{"error":"Workspace is at its contact limit"}'
    end
    @server.mount_proc("/redirect/v1/track") do |_req, res|
      res.status = 302
      res["Location"] = "http://127.0.0.1:9/elsewhere"
    end
    @thread = Thread.new { @server.start }
    @port = @server.config[:Port]
  end

  def teardown
    @server.shutdown
    @thread.join
  end

  def client(prefix = "", **extra)
    Loomail::Client.new(secret_key: "mf_live_http", host: "http://127.0.0.1:#{@port}#{prefix}", sleeper: ->(_s) {}, **extra)
  end

  def test_sends_a_json_post_with_the_key_over_real_http
    result = client("/echo").track("u1", "paid", { amount: 1 })
    assert result.deduplicated?
    seen = @seen.first
    assert_equal "Bearer mf_live_http", seen[:auth]
    assert_equal "application/json", seen[:ct]
    assert_match(%r{\Aloomail-ruby/}, seen[:ua])
    assert_equal "paid", seen[:body]["event"]
  end

  def test_a_4xx_comes_back_as_an_error_with_the_servers_message
    error = assert_raises(Loomail::Error) { client("/limit").track("u1", "e") }
    assert_equal :plan_limit, error.code
    assert_equal 402, error.status
    assert_includes error.message, "contact limit"
  end

  def test_a_timeout_is_a_network_error
    error = assert_raises(Loomail::Error) { client("/slow", timeout: 0.3, max_retries: 0).track("u1", "e") }
    assert_equal :network, error.code
  end

  def test_a_dead_port_is_a_network_error
    c = Loomail::Client.new(secret_key: "mf_live_x", host: "http://127.0.0.1:1", max_retries: 1, sleeper: ->(_s) {})
    assert_equal :network, assert_raises(Loomail::Error) { c.track("u1", "e") }.code
  end

  def test_redirects_are_not_followed
    error = assert_raises(Loomail::Error) { client("/redirect").track("u1", "e") }
    assert_equal 302, error.status
  end

  def test_a_bad_address_is_a_network_error_not_a_crash
    c = Loomail::Client.new(secret_key: "mf_live_x", host: "http://exa mple.invalid", max_retries: 0, sleeper: ->(_s) {})
    assert_equal :network, assert_raises(Loomail::Error) { c.track("u1", "e") }.code
  end
end
