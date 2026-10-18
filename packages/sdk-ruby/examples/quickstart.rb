# Sends a few events to a real Loomail.
# Usage: LOOMAIL_SECRET_KEY=mf_live_... LOOMAIL_HOST=http://localhost:3000 ruby -Ilib examples/quickstart.rb [prefix]
require "loomail"

prefix = ARGV[0] || "ruby"
id = "#{prefix}_user"
loomail = Loomail::Client.new

loomail.identify(id, email: "#{prefix}@example.com", plan: "trial", n: 1)
first = loomail.track(id, "signed_up", { source: prefix }, message_id: "su:#{prefix}")
again = loomail.track(id, "signed_up", { source: prefix }, message_id: "su:#{prefix}")
puts "deduplicated first=#{first.deduplicated?} again=#{again.deduplicated?}"

res = loomail.batch([
  { type: :identify, user_id: id, traits: { plan: "pro" } },
  { type: :track, user_id: id, event: "upgraded", properties: { plan: "pro" }, timestamp: Time.now - 3600 },
  { type: :track, user_id: id, event: "viewed" }
])
puts "batch received=#{res.received} errors=#{res.errors.length}"

begin
  Loomail::Client.new(secret_key: "mf_live_wrong", max_retries: 0).track(id, "nope")
rescue Loomail::Error => e
  puts "bad key => #{e.code} #{e.status}"
end
