# frozen_string_literal: true

module Loomail
  # Raised when Loomail cannot be reached or refuses a call.
  #
  # #code is one of:
  #   :invalid_argument  caught before any request was made
  #   :unauthorized      401: key missing, wrong or revoked
  #   :forbidden         403: key not allowed here
  #   :plan_limit        402: workspace is at its contact limit
  #   :validation        400 / 422: Loomail did not accept the payload
  #   :rate_limited      429, still failing after retries
  #   :server            5xx, still failing after retries
  #   :network           could not reach Loomail, or it did not answer in time
  class Error < StandardError
    attr_reader :code, :status, :body

    def initialize(code, message, status: nil, body: nil)
      super(message)
      @code = code
      @status = status
      @body = body
    end
  end

  # What #identify and #track return.
  Result = Struct.new(:deduplicated, keyword_init: true) do
    # True when Loomail had already seen this message_id and ignored the repeat.
    def deduplicated?
      deduplicated == true
    end
  end

  # What #batch returns. +errors+ is an array of { index:, message:, code: } for the items Loomail refused.
  BatchResult = Struct.new(:received, :errors, keyword_init: true)
end
