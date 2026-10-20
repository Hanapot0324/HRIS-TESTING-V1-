import 'package:flutter/foundation.dart';

/// Build-time configuration.
///
/// The backend URL is passed at build time and never hard-coded:
///
///   flutter run --dart-define=API_BASE_URL=https://hris.example.edu.ph
///
/// No secrets (JWT keys, DB credentials, API keys) belong in this app.
class AppConfig {
  static const String _apiBaseUrl = String.fromEnvironment('API_BASE_URL');

  /// Hosts that may use plain HTTP, and only in debug builds (local backend,
  /// Android emulator loopback).
  static const Set<String> _devHosts = {'localhost', '127.0.0.1', '10.0.2.2'};

  /// Validated backend base URI. Throws [StateError] when missing or unsafe.
  static Uri baseUri({String raw = _apiBaseUrl, bool debug = kDebugMode}) {
    if (raw.trim().isEmpty) {
      throw StateError(
        'API_BASE_URL is not set. Build with '
        '--dart-define=API_BASE_URL=https://<your-hris-server>',
      );
    }
    final uri = Uri.tryParse(raw.trim());
    if (uri == null || !uri.hasScheme || uri.host.isEmpty) {
      throw StateError('API_BASE_URL is not a valid URL.');
    }
    final isHttps = uri.scheme == 'https';
    final isAllowedDevHttp =
        debug && uri.scheme == 'http' && _devHosts.contains(uri.host);
    if (!isHttps && !isAllowedDevHttp) {
      throw StateError('API_BASE_URL must use https://.');
    }
    return uri;
  }
}
