# frozen_string_literal: true

require "minitest/autorun"
require "json"
require "loomail"

# A scripted transport that records every request. The last scripted answer repeats; a Loomail::Client::TransportError
# in the script is raised instead of answered.
class FakeTransport
  Request = Struct.new(:url, :headers, :body, :timeout, :json, keyword_init: true)

  attr_reader :requests

  def initialize(*script)
    script = [[200, {}, '{"success":true}']] if script.empty?
    @script = script
    @requests = []
  end

  def call(url, headers, body, timeout)
    @requests << Request.new(url: url, headers: headers, body: body, timeout: timeout, json: JSON.parse(body))
    answer = @script[[@requests.length, @script.length].min - 1]
    raise answer if answer.is_a?(Exception)

    answer
  end

  def self.json(status, body, headers = {})
    [status, headers, JSON.generate(body)]
  end
end
