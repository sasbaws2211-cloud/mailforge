# frozen_string_literal: true

require_relative "lib/loomail/version"

Gem::Specification.new do |spec|
  spec.name = "loomail"
  spec.version = Loomail::VERSION
  spec.authors = ["Loomail"]
  spec.summary = "Server-side client for Loomail: send identify and track events with a secret key."
  spec.description = "Zero-dependency Ruby client for Loomail's ingestion API, with retries, idempotent calls and a Rails integration."
  spec.homepage = "https://loomail.site"
  spec.license = "MIT"
  spec.required_ruby_version = ">= 3.0"
  spec.metadata = {
    "homepage_uri" => spec.homepage,
    "source_code_uri" => "https://github.com/sasbaws2211-cloud/mailforge/tree/main/packages/sdk-ruby",
    "rubygems_mfa_required" => "true"
  }
  spec.files = Dir["lib/**/*.rb", "README.md", "LICENSE"]
  spec.require_paths = ["lib"]

  spec.add_development_dependency "activejob", ">= 6.1"
  spec.add_development_dependency "minitest", "~> 5.20"
  spec.add_development_dependency "rake", "~> 13.0"
  spec.add_development_dependency "railties", ">= 6.1"
  spec.add_development_dependency "webrick", "~> 1.8"
end
