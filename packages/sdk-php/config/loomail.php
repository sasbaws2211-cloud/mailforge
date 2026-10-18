<?php

return [
    // A secret key (mf_live_...). Never use it in browser code.
    'secret_key' => env('LOOMAIL_SECRET_KEY'),

    // Your Loomail install. Leave empty for https://loomail.site.
    'host' => env('LOOMAIL_HOST'),

    // Seconds allowed for each attempt.
    'timeout' => 10,

    // Retries after the first attempt, on network errors, 429 and 5xx.
    'max_retries' => 3,
];
