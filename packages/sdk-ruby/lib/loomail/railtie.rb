# frozen_string_literal: true

require "rails/railtie"

module Loomail
  # Rails integration. Loaded automatically when Rails is present. Reads, in this order of preference:
  #
  #   config.loomail.secret_key / .host / .timeout / .max_retries   (config/application.rb or an environment file)
  #   Rails credentials:  loomail: { secret_key: ..., host: ... }
  #   ENV["LOOMAIL_SECRET_KEY"] and ENV["LOOMAIL_HOST"]
  #
  # Then Loomail.identify / Loomail.track work anywhere, and Loomail.track_later runs on ActiveJob.
  class Railtie < ::Rails::Railtie
    config.loomail = ActiveSupport::OrderedOptions.new

    initializer "loomail.configure" do |app|
      creds = app.credentials.respond_to?(:loomail) ? app.credentials.loomail : nil
      creds = creds.to_h if creds.respond_to?(:to_h)
      creds ||= {}
      settings = app.config.loomail

      Loomail.configure do |c|
        c.secret_key = settings.secret_key || creds[:secret_key]
        c.host = settings.host || creds[:host]
        c.timeout = settings.timeout || creds[:timeout] || c.timeout
        c.max_retries = settings.max_retries || creds[:max_retries] || c.max_retries
      end
    end
  end
end
