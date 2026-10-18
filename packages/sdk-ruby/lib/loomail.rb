# frozen_string_literal: true

require_relative "loomail/version"
require_relative "loomail/error"
require_relative "loomail/client"

# Server-side client for Loomail. See Loomail::Client.
#
# Configure once (a Rails app does this from config.loomail, credentials or the environment automatically):
#
#   Loomail.configure do |c|
#     c.secret_key = ENV["LOOMAIL_SECRET_KEY"]
#     c.host = "https://loomail.example.com" # only for a self-hosted install
#   end
#
#   Loomail.identify(user.id, email: user.email)
#   Loomail.track(user.id, "signed_up")
module Loomail
  # Settings for the shared client. Anything left empty falls back to LOOMAIL_SECRET_KEY / LOOMAIL_HOST.
  class Configuration
    attr_accessor :secret_key, :host, :timeout, :max_retries

    def initialize
      @timeout = 10
      @max_retries = 3
    end
  end

  class << self
    def configuration
      @configuration ||= Configuration.new
    end

    def configure
      yield configuration
      @client = nil
      configuration
    end

    # The shared client, built from the configuration on first use.
    def client
      @client ||= Client.new(
        secret_key: configuration.secret_key,
        host: configuration.host,
        timeout: configuration.timeout,
        max_retries: configuration.max_retries
      )
    end

    # Replace the shared client (tests).
    attr_writer :client

    def reset!
      @client = nil
      @configuration = nil
    end

    def identify(user_id, traits = {}, **keywords)
      client.identify(user_id, traits, **keywords)
    end

    def track(user_id, event, properties = {}, **keywords)
      client.track(user_id, event, properties, **keywords)
    end

    def batch(items)
      client.batch(items)
    end

    # Same as identify / track, on a background job (Rails with ActiveJob), so a Loomail outage cannot slow or fail the
    # request. Without ActiveJob it calls straight away and logs nothing.
    def identify_later(user_id, traits = {}, **options)
      enqueue(:identify, [user_id, traits], options)
    end

    def track_later(user_id, event, properties = {}, **options)
      enqueue(:track, [user_id, event, properties], options)
    end

    private

    def enqueue(method, args, options)
      options = options.dup
      # A time becomes text, and a message_id is fixed now, so a retried job cannot double-count.
      options[:timestamp] = options[:timestamp].utc.iso8601(3) if options[:timestamp].respond_to?(:utc)
      options[:message_id] ||= SecureRandom.uuid
      if defined?(::ActiveJob)
        require_relative "loomail/deliver_job"
        Loomail::DeliverJob.perform_later(method.to_s, args, options.transform_keys(&:to_s))
      else
        public_send(method, *args, **options)
      end
    end
  end
end

require_relative "loomail/railtie" if defined?(::Rails::Railtie)
