import 'package:flutter/material.dart';

import '../../api/api_client.dart';

/// Loads data and renders consistent loading / empty / error / access-denied
/// states with pull-to-refresh and a retry button. Loads once per widget
/// instance; give it a new [Key] to load different data (e.g. a new period).
class AsyncBody<T> extends StatefulWidget {
  const AsyncBody({
    super.key,
    required this.load,
    required this.builder,
    this.isEmpty,
    this.emptyMessage = 'Nothing to show yet.',
  });

  final Future<T> Function() load;
  final Widget Function(
    BuildContext context,
    T data,
    Future<void> Function() reload,
  )
  builder;
  final bool Function(T data)? isEmpty;
  final String emptyMessage;

  @override
  State<AsyncBody<T>> createState() => AsyncBodyState<T>();
}

class AsyncBodyState<T> extends State<AsyncBody<T>> {
  late Future<T> _future;

  @override
  void initState() {
    super.initState();
    _future = widget.load();
  }

  Future<void> reload() {
    final f = widget.load();
    setState(() => _future = f);
    return f.then((_) {}, onError: (_) {});
  }

  @override
  Widget build(BuildContext context) {
    return FutureBuilder<T>(
      future: _future,
      builder: (context, snap) {
        if (snap.connectionState != ConnectionState.done) {
          return const Center(child: CircularProgressIndicator());
        }
        if (snap.hasError) {
          final err = snap.error;
          final denied =
              err is ApiException && err.kind == ApiErrorKind.accessDenied;
          return _Scrollable(
            onRefresh: reload,
            child: StatusMessage(
              icon: denied ? Icons.lock_outline : Icons.cloud_off_outlined,
              title: denied ? 'Access denied' : 'Could not load',
              message:
                  err is ApiException
                      ? err.message
                      : 'Something went wrong. Please try again.',
              action:
                  denied
                      ? null
                      : FilledButton.tonal(
                        onPressed: reload,
                        child: const Text('Try again'),
                      ),
            ),
          );
        }
        final data = snap.data as T;
        if (widget.isEmpty?.call(data) ?? false) {
          return _Scrollable(
            onRefresh: reload,
            child: StatusMessage(
              icon: Icons.inbox_outlined,
              title: widget.emptyMessage,
            ),
          );
        }
        return RefreshIndicator(
          onRefresh: reload,
          child: widget.builder(context, data, reload),
        );
      },
    );
  }
}

class _Scrollable extends StatelessWidget {
  const _Scrollable({required this.onRefresh, required this.child});

  final Future<void> Function() onRefresh;
  final Widget child;

  @override
  Widget build(BuildContext context) => RefreshIndicator(
    onRefresh: onRefresh,
    child: ListView(
      physics: const AlwaysScrollableScrollPhysics(),
      children: [const SizedBox(height: 96), child],
    ),
  );
}

class StatusMessage extends StatelessWidget {
  const StatusMessage({
    super.key,
    required this.icon,
    required this.title,
    this.message,
    this.action,
  });

  final IconData icon;
  final String title;
  final String? message;
  final Widget? action;

  @override
  Widget build(BuildContext context) {
    final theme = Theme.of(context);
    return Padding(
      padding: const EdgeInsets.all(24),
      child: Column(
        mainAxisSize: MainAxisSize.min,
        children: [
          Icon(icon, size: 48, color: theme.colorScheme.outline),
          const SizedBox(height: 12),
          Text(
            title,
            style: theme.textTheme.titleMedium,
            textAlign: TextAlign.center,
          ),
          if (message != null) ...[
            const SizedBox(height: 8),
            Text(
              message!,
              textAlign: TextAlign.center,
              style: theme.textTheme.bodyMedium,
            ),
          ],
          if (action != null) ...[const SizedBox(height: 16), action!],
        ],
      ),
    );
  }
}

/// Small labelled value used across detail cards.
class InfoRow extends StatelessWidget {
  const InfoRow(this.label, this.value, {super.key});

  final String label;
  final String value;

  @override
  Widget build(BuildContext context) {
    final theme = Theme.of(context);
    return Padding(
      padding: const EdgeInsets.symmetric(vertical: 6),
      child: Row(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: [
          SizedBox(
            width: 130,
            child: Text(
              label,
              style: theme.textTheme.bodyMedium?.copyWith(
                color: theme.colorScheme.onSurfaceVariant,
              ),
            ),
          ),
          Expanded(child: Text(value, style: theme.textTheme.bodyMedium)),
        ],
      ),
    );
  }
}

void showSnack(BuildContext context, String message) {
  ScaffoldMessenger.of(context)
    ..hideCurrentSnackBar()
    ..showSnackBar(SnackBar(content: Text(message)));
}
