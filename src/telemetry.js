'use strict';
/*
 * OpenTelemetry: ślady (traces), metryki i logi aplikacji – np. do Zabbix 8 APM (OTLP/gRPC przez proxy Zabbix),
 * OpenTelemetry Collector, Grafany czy Jaegera. Konfiguracja standardowymi zmiennymi OTEL_* :
 *
 *   OTEL_EXPORTER_OTLP_ENDPOINT=http://zabbix-proxy:4317   adres odbiorcy
 *   OTEL_EXPORTER_OTLP_PROTOCOL=grpc                        grpc (Zabbix) albo http/protobuf (domyślnie)
 *   OTEL_SERVICE_NAME=home-manager                          nazwa usługi w APM
 *   OTEL_METRICS_EXPORTER=otlp,prometheus                   dodatkowo /metrics w formacie Prometheus (port 9464)
 *
 * Bez tych zmiennych nic się nie uruchamia – zero narzutu.
 * Moduł trzeba załadować przed http i pg (robi to src/server.js na samym początku).
 */

const pkg = require('../package.json');

const truthy = (v) => ['1', 'true', 'yes', 'on'].includes(String(v ?? '').toLowerCase());

function isEnabled(env = process.env) {
  if (truthy(env.OTEL_SDK_DISABLED)) return false;
  return Boolean(
    env.OTEL_EXPORTER_OTLP_ENDPOINT || env.OTEL_EXPORTER_OTLP_TRACES_ENDPOINT || env.OTEL_EXPORTER_OTLP_METRICS_ENDPOINT
      || /prometheus|console/.test(env.OTEL_METRICS_EXPORTER ?? '') || truthy(env.OTEL_ENABLED)
  );
}

/** Ruch, którego nie ma sensu śledzić: pliki interfejsu, zdjęcia, sprawdzanie zdrowia. */
function ignoreIncoming(req) {
  const url = req.url ?? '';
  return !url.startsWith('/api/') || url.startsWith('/api/health');
}

let sdk = null;

function startIfEnabled(env = process.env) {
  if (sdk || !isEnabled(env)) return null;
  const { NodeSDK } = require('@opentelemetry/sdk-node');
  const { HttpInstrumentation } = require('@opentelemetry/instrumentation-http');
  const { PgInstrumentation } = require('@opentelemetry/instrumentation-pg');
  const { resourceFromAttributes } = require('@opentelemetry/resources');

  sdk = new NodeSDK({
    serviceName: env.OTEL_SERVICE_NAME || 'home-manager',
    resource: resourceFromAttributes({
      'service.version': pkg.version,
      'service.namespace': env.OTEL_SERVICE_NAMESPACE || 'home',
    }),
    instrumentations: [
      new HttpInstrumentation({
        ignoreIncomingRequestHook: ignoreIncoming,
        // Zapytania do Open Food Facts i innych usług też są śledzone; samego eksportu OTLP nie.
        ignoreOutgoingRequestHook: (opts) => String(opts.path ?? '').startsWith('/v1/'),
      }),
      new PgInstrumentation({ enhancedDatabaseReporting: false }),
    ],
  });
  sdk.start();
  bridgeConsole();

  const stop = () => sdk.shutdown().catch(() => {});
  process.once('SIGTERM', stop);
  process.once('SIGINT', stop);
  return sdk;
}

/** Logi aplikacji (console.*) trafiają też do OpenTelemetry – powiązane z bieżącym śladem. */
function bridgeConsole() {
  const { logs } = require('@opentelemetry/api');
  const logger = logs.getLogger('home-manager', pkg.version);
  const levels = { log: [9, 'INFO'], info: [9, 'INFO'], warn: [13, 'WARN'], error: [17, 'ERROR'] };
  for (const [method, [severityNumber, severityText]] of Object.entries(levels)) {
    const original = console[method].bind(console);
    console[method] = (...args) => {
      original(...args);
      try {
        const err = args.find((a) => a instanceof Error);
        logger.emit({
          severityNumber,
          severityText,
          body: args.map((a) => (a instanceof Error ? a.message : typeof a === 'string' ? a : JSON.stringify(a))).join(' '),
          attributes: err ? { 'exception.type': err.name, 'exception.message': err.message, 'exception.stacktrace': err.stack } : {},
        });
      } catch { /* logowanie nie może zatrzymać aplikacji */ }
    };
  }
}

function shutdown() {
  return sdk ? sdk.shutdown() : Promise.resolve();
}

module.exports = { startIfEnabled, isEnabled, shutdown, ignoreIncoming };
