# frozen_string_literal: true

require "test_helper"
require "tmpdir"
require "rails"
require "active_job"
require "active_job/railtie"
require "loomail/railtie"

# Credentials, kept in a throwaway encrypted file.
CRED_DIR = Dir.mktmpdir("loomail-rails")
CRED_KEY = File.join(CRED_DIR, "test.key")
CRED_FILE = File.join(CRED_DIR, "test.yml.enc")
File.write(CRED_KEY, ActiveSupport::EncryptedConfiguration.generate_key)
ActiveSupport::EncryptedConfiguration.new(config_path: CRED_FILE, key_path: CRED_KEY, env_key: "NONE", raise_if_missing_key: true)
                                     .write("loomail:\n  secret_key: mf_live_from_credentials\n  host: https://creds.example.com\n  max_retries: 2\n")

class LoomailTestApp < Rails::Application
  config.eager_load = false
  config.secret_key_base = "x" * 64
  config.logger = Logger.new(File::NULL)
  config.credentials.content_path = CRED_FILE
  config.credentials.key_path = CRED_KEY
  config.active_job.queue_adapter = :test
  config.loomail.timeout = 4 # set the way a real app does, in config
end

LoomailTestApp.initialize!

class RailsTest < ActiveJob::TestCase
  def setup
    @transport = FakeTransport.new
    Loomail.client.instance_variable_set(:@transport, @transport)
  end

  def test_the_railtie_reads_config_and_falls_back_to_credentials
    c = Loomail.configuration
    assert_equal "mf_live_from_credentials", c.secret_key # not set in config, so credentials
    assert_equal "https://creds.example.com", c.host
    assert_equal 4, c.timeout # set in config, wins over the default
    assert_equal 2, c.max_retries
  end

  def test_track_works_through_the_shared_client
    Loomail.track("u1", "signed_up")
    assert_equal "https://creds.example.com/v1/track", @transport.requests.first.url
    assert_equal "Bearer mf_live_from_credentials", @transport.requests.first.headers["Authorization"]
  end

  def test_track_later_queues_a_job_with_a_fixed_message_id_and_it_sends_when_performed
    assert_enqueued_with(job: Loomail::DeliverJob) do
      Loomail.track_later("u1", "upgraded", { plan: "pro" }, timestamp: Time.utc(2026, 5, 1, 10))
    end
    job = enqueued_jobs.last
    args = ActiveJob::Arguments.deserialize(job["arguments"])
    assert_equal "track", args[0]
    assert_match(/\A[0-9a-f-]{36}\z/, args[2]["message_id"])
    assert_equal "2026-05-01T10:00:00.000Z", args[2]["timestamp"]

    perform_enqueued_jobs { Loomail::DeliverJob.perform_later(*args) }
    sent = @transport.requests.last.json
    assert_equal "upgraded", sent["event"]
    assert_equal({ "plan" => "pro" }, sent["properties"])
    assert_equal args[2]["message_id"], sent["messageId"]
  end

  def test_identify_later_queues_an_identify
    assert_enqueued_jobs 1 do
      Loomail.identify_later("u1", { plan: "pro" })
    end
    args = ActiveJob::Arguments.deserialize(enqueued_jobs.last["arguments"])
    assert_equal "identify", args[0]
  end

  def test_the_job_drops_what_retrying_cannot_fix_and_retries_an_outage
    Loomail.client.instance_variable_set(:@transport, FakeTransport.new(FakeTransport.json(402, { error: "limit" })))
    perform_enqueued_jobs do
      Loomail::DeliverJob.perform_later("track", ["u1", "e", {}], {}) # a plan limit: logged and dropped, no exception
    end
    assert_empty enqueued_jobs

    Loomail.client.instance_variable_set(:@transport, FakeTransport.new([503, {}, "down"]))
    Loomail.client.instance_variable_set(:@max_retries, 0)
    Loomail::DeliverJob.perform_later("track", ["u1", "e", {}], {})
    perform_enqueued_jobs(only: Loomail::DeliverJob) rescue nil
    assert_operator enqueued_jobs.length, :>=, 1, "an outage is retried (a new job is queued), not dropped"
  end
end
