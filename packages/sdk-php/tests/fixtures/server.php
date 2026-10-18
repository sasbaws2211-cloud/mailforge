<?php

// Router for `php -S`: a tiny fake Loomail. Behaviour is chosen by the path.
$path = parse_url($_SERVER['REQUEST_URI'], PHP_URL_PATH);
$body = file_get_contents('php://input');
header('Content-Type: application/json');

if ($path === '/echo/v1/track') {
    echo json_encode([
        'success' => true,
        'seen' => [
            'auth' => $_SERVER['HTTP_AUTHORIZATION'] ?? null,
            'content_type' => $_SERVER['CONTENT_TYPE'] ?? null,
            'user_agent' => $_SERVER['HTTP_USER_AGENT'] ?? null,
            'body' => json_decode($body, true),
        ],
    ]);
} elseif ($path === '/slow/v1/track') {
    usleep(1_500_000);
    echo '{"success":true}';
} elseif ($path === '/redirect/v1/track') {
    http_response_code(302);
    header('Location: http://127.0.0.1:9/elsewhere');
} elseif ($path === '/limit/v1/track') {
    http_response_code(402);
    echo json_encode(['error' => 'Workspace is at its contact limit']);
} else {
    http_response_code(404);
    echo '{"error":"no such route"}';
}
