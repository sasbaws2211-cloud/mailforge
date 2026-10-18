<?php

declare(strict_types=1);

namespace Loomail;

/** No answer from Loomail: it could not be reached, or did not reply in time. */
final class TransportException extends \RuntimeException
{
}
