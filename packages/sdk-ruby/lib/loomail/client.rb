# frozen_string_literal: true

require "json"
require "net/http"
require "securerandom"
require "time"
require "uri"

module Loomail
  # Server-side client for Loomail's ingestion API.
  #
  # Sends identify and track calls with a secret key (mf_live_...), retries what is safe to retry, and never
  # double-counts: every call carries a message_id, which Loomail uses to drop repeats.
  #
  #   loomail = Loomail::Client.new(secret_key: ENV["LOOMAIL_SECRET_KEY"])
  #   loomail.identify("user_123", { email: "a@b.c", plan: "trial" })
  #   loomail.track("user_123", "signed_up", { source: "ads" })
  #
  # Methods raise Loomail::Error when Loomail cannot be reached or refuses the call. In a web request that means a
  # Loomail outage can fail the request, so use Loomail.track_later (Rails) or rescue Loomail::Error for fire-and-forget.
  class Client
    DEFAULT_HOST = "https://loomail.site"
    # Loomail rejects a batch of more than 100 items or more than 512 KB.
    MAX_BATCH_ITEMS = 100
    MAX_BATCH_BYTES = 400 * 1024 # headroom under the server's 512 KB body limit

    # secret_key:  mf_live_... (default ENV["LOOMAIL_SECRET_KEY"]). Never use it in a browser.
    # host:        your Loomail install (default ENV["LOOMAIL_HOST"], then https://loomail.site)
    # timeout:     seconds per attempt (default 10)
    # max_retries: retries after the first attempt, on network errors, 429 and 5xx (default 3)
    # transport:   replaces Net::HTTP (tests, proxies): callable(url, headers, body, timeout) returning
    #              [status, headers_hash_with_lowercase_keys, body_string], raising Loomail::Client::TransportError
    # sleeper:     replaces the wait between retries (tests): callable(seconds)
    def initialize(secret_key: nil, host: nil, timeout: 10, max_retries: 3, transport: nil, sleeper: nil)
      key = secret_key || ENV["LOOMAIL_SECRET_KEY"]
      if key.nil? || key.empty?
        raise Error.new(:invalid_argument, "secret_key is required (or set LOOMAIL_SECRET_KEY)")
      end
      if key.start_with?("mf_pub_")
        raise Error.new(:invalid_argument,
                        "That is a publishable key (mf_pub_...), meant for browsers. Server code needs a secret key (mf_live_...).")
      end

      @secret_key = key
      host = host || ENV["LOOMAIL_HOST"]
      host = DEFAULT_HOST if host.nil? || host.empty?
      @host = host.sub(%r{/+\z}, "")
      @timeout = timeout.to_f
      @max_retries = [max_retries.to_i, 0].max
      @transport = transport || method(:net_http)
      @sleeper = sleeper || ->(seconds) { sleep(seconds) }
    end

    # No answer from the server: it could not be reached, or did not reply in time.
    class TransportError < StandardError; end

    OPTION_KEYS = %i[timestamp message_id context].freeze

    # Create or update a person. Traits merge into what Loomail already knows; a nil trait removes it.
    #
    #   client.identify("u1", { email: "a@b.c" })   # a Hash of traits
    #   client.identify("u1", email: "a@b.c")       # or plain keywords
    #
    # The options timestamp: (Time, DateTime or String), message_id: and context: (Hash) are reserved words: a trait
    # with one of those names has to go in the Hash form.
    def identify(user_id, traits = {}, **keywords)
      options, extra = split_keywords(keywords)
      send_call("/v1/identify", identify_body(user_id, merge_data(traits, extra), options[:timestamp], options[:message_id], options[:context]))
    end

    # Record something a person did. Properties go in a Hash or as plain keywords, like traits in #identify.
    def track(user_id, event, properties = {}, **keywords)
      options, extra = split_keywords(keywords)
      send_call("/v1/track", track_body(user_id, event, merge_data(properties, extra), options[:timestamp], options[:message_id], options[:context]))
    end

    # Send many identify/track items. Splits them into requests of at most 100 items (and under the size limit), so any
    # length is fine. A refused item lands in the result's +errors+ and does not stop the rest; a request that fails
    # outright (bad key, an outage after retries) raises.
    #
    #   loomail.batch([
    #     { type: :identify, user_id: "u1", traits: { plan: "pro" } },
    #     { type: :track, user_id: "u1", event: "upgraded", properties: { plan: "pro" }, message_id: "up:1" }
    #   ])
    def batch(items)
      prepared = items.each_with_index.map do |item, i|
        item = item.transform_keys(&:to_sym)
        begin
          case item[:type]&.to_s
          when "identify"
            identify_body(item[:user_id], item[:traits] || {}, item[:timestamp], item[:message_id], item[:context]).merge(type: "identify")
          when "track"
            track_body(item[:user_id], item[:event], item[:properties] || {}, item[:timestamp], item[:message_id], item[:context]).merge(type: "track")
          else
            raise Error.new(:invalid_argument, 'type must be "identify" or "track"')
          end
        rescue Error => e
          raise Error.new(:invalid_argument, "batch[#{i}]: #{e.message}")
        end
      end

      received = 0
      errors = []
      chunk = []
      chunk_bytes = 0
      chunk_start = 0
      flush = lambda do
        next if chunk.empty?

        res = post("/v1/batch", { batch: chunk })
        received += res["received"].to_i
        Array(res["errors"]).each do |err|
          entry = { index: err["index"].to_i + chunk_start, message: err["message"].to_s }
          entry[:code] = err["code"] if err["code"]
          errors << entry
        end
        chunk_start += chunk.length
        chunk = []
        chunk_bytes = 0
      end
      prepared.each do |item|
        size = encode(item).bytesize + 1
        flush.call if chunk.length >= MAX_BATCH_ITEMS || (!chunk.empty? && chunk_bytes + size > MAX_BATCH_BYTES)
        chunk << item
        chunk_bytes += size
      end
      flush.call
      BatchResult.new(received: received, errors: errors)
    end

    private

    # Keywords that are options, and the rest (which are data).
    def split_keywords(keywords)
      options = keywords.slice(*OPTION_KEYS)
      [options, keywords.reject { |key, _| OPTION_KEYS.include?(key) }]
    end

    def merge_data(hash, extra)
      return hash if extra.empty?

      (hash || {}).merge(extra)
    end

    def base_body(user_id, timestamp, message_id, context)
      raise Error.new(:invalid_argument, "userId must be a non-empty string") if user_id.nil? || user_id.to_s.strip.empty?

      body = { userId: user_id.to_s, messageId: (message_id || SecureRandom.uuid).to_s }
      body[:timestamp] = iso(timestamp) unless timestamp.nil?
      body[:context] = context unless context.nil?
      body
    end

    def identify_body(user_id, traits, timestamp, message_id, context)
      base_body(user_id, timestamp, message_id, context).merge(traits: traits || {})
    end

    def track_body(user_id, event, properties, timestamp, message_id, context)
      body = base_body(user_id, timestamp, message_id, context)
      raise Error.new(:invalid_argument, "event must be a non-empty string") if event.nil? || event.to_s.strip.empty?

      body.merge(event: event.to_s, properties: properties || {})
    end

    def iso(value)
      time =
        case value
        when Time then value
        when String then Time.parse(value)
        else value.respond_to?(:to_time) ? value.to_time : raise(ArgumentError)
        end
      time.utc.strftime("%Y-%m-%dT%H:%M:%S.%LZ")
    rescue ArgumentError, TypeError
      raise Error.new(:invalid_argument, "timestamp is not a valid date: #{value}")
    end

    def encode(body)
      JSON.generate(body)
    rescue JSON::GeneratorError, Encoding::UndefinedConversionError => e
      raise Error.new(:invalid_argument, "The data could not be encoded as JSON: #{e.message}")
    end

    def send_call(path, body)
      Result.new(deduplicated: post(path, body)["deduplicated"] == true)
    end

    def code_for_status(status)
      case status
      when 401 then :unauthorized
      when 402 then :plan_limit
      when 403 then :forbidden
      when 429 then :rate_limited
      when 500.. then :server
      else :validation
      end
    end

    # One POST with retries. Every body here carries a messageId, so repeating it is safe.
    def post(path, body)
      payload = encode(body)
      headers = {
        "Authorization" => "Bearer #{@secret_key}",
        "Content-Type" => "application/json",
        "User-Agent" => "loomail-ruby/#{VERSION}"
      }
      attempt = 0
      loop do
        begin
          status, response_headers, raw = @transport.call(@host + path, headers, payload, @timeout)
        rescue TransportError => e
          if attempt >= @max_retries
            raise Error.new(:network, "Could not reach Loomail at #{@host}: #{e.message}")
          end

          @sleeper.call([backoff(attempt), 30.0].min)
          attempt += 1
          next
        end

        parsed = parse(raw)
        return parsed.is_a?(Hash) ? parsed : {} if status.between?(200, 299)

        retryable = status == 429 || status >= 500
        if !retryable || attempt >= @max_retries
          detail = parsed.is_a?(Hash) && parsed["error"].is_a?(String) ? ": #{parsed['error']}" : ""
          raise Error.new(code_for_status(status), "Loomail answered #{status}#{detail}", status: status, body: parsed)
        end

        after = Float(response_headers["retry-after"], exception: false) if response_headers["retry-after"]
        wait = after && after >= 0 ? after : backoff(attempt)
        @sleeper.call([wait, 30.0].min)
        attempt += 1
      end
    end

    def parse(raw)
      return nil if raw.nil? || raw.empty?

      JSON.parse(raw)
    rescue JSON::ParserError
      raw
    end

    # 0.5s, 1s, 2s... with up to 25% jitter.
    def backoff(attempt)
      base = 0.5 * (2**attempt)
      base + rand * base * 0.25
    end

    # The default transport.
    def net_http(url, headers, body, timeout)
      uri = URI.parse(url)
      http = Net::HTTP.new(uri.host, uri.port)
      http.use_ssl = uri.scheme == "https"
      http.open_timeout = [timeout, 10.0].min
      http.read_timeout = timeout
      http.write_timeout = timeout
      request = Net::HTTP::Post.new(uri.request_uri, headers)
      request.body = body
      response = http.start { |h| h.request(request) }
      [response.code.to_i, response.each_header.to_h.transform_keys(&:downcase), response.body.to_s]
    rescue Net::OpenTimeout, Net::ReadTimeout, Net::WriteTimeout, Timeout::Error => e
      raise TransportError, "timed out (#{e.class})"
    rescue SocketError, SystemCallError, IOError, OpenSSL::SSL::SSLError, EOFError, URI::InvalidURIError => e
      raise TransportError, "#{e.class}: #{e.message}"
    end
  end
end
