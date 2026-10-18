# frozen_string_literal: true

require "active_job"

module Loomail
  # Sends one identify or track from a background job. The call keeps the message_id it was queued with, so a retry of
  # the job (or a duplicate delivery) is recognised by Loomail and not counted twice.
  class DeliverJob < ::ActiveJob::Base
    RETRYABLE = %i[network server rate_limited].freeze

    queue_as :default

    # An outage or a rate limit is retried with a growing wait. Anything else (a bad key, a plan limit, a payload Loomail
    # refuses) cannot be fixed by retrying, so it is logged and dropped in #perform.
    retry_on Loomail::Error, wait: :polynomially_longer, attempts: 5

    def perform(method, args, options)
      Loomail.public_send(method, *args, **options.transform_keys(&:to_sym))
    rescue Loomail::Error => e
      raise if RETRYABLE.include?(e.code)

      logger&.warn("[loomail] dropped #{method}: #{e.message}")
    end
  end
end
