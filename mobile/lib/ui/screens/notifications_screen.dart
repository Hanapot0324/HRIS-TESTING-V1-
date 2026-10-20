import 'package:flutter/material.dart';

import '../../api/api_client.dart';
import '../../data/hris_repository.dart';
import '../../data/models.dart';
import '../theme.dart';
import '../widgets/async_body.dart';

class NotificationsScreen extends StatefulWidget {
  const NotificationsScreen({super.key, required this.repo});

  final HrisRepository repo;

  @override
  State<NotificationsScreen> createState() => _NotificationsScreenState();
}

class _NotificationsScreenState extends State<NotificationsScreen> {
  final _bodyKey = GlobalKey<AsyncBodyState<List<AppNotification>>>();

  Future<void> _markRead(AppNotification n) async {
    if (n.read) return;
    try {
      await widget.repo.markNotificationRead(n.id);
    } on ApiException catch (e) {
      if (mounted) showSnack(context, e.message);
    }
    await _bodyKey.currentState?.reload();
  }

  Future<void> _markAll() async {
    try {
      await widget.repo.markAllNotificationsRead();
    } on ApiException catch (e) {
      if (mounted) showSnack(context, e.message);
    }
    await _bodyKey.currentState?.reload();
  }

  @override
  Widget build(BuildContext context) {
    return Scaffold(
      appBar: AppBar(
        title: const Text('Notifications'),
        actions: [
          TextButton(onPressed: _markAll, child: const Text('Mark all read')),
        ],
      ),
      body: AsyncBody<List<AppNotification>>(
        key: _bodyKey,
        load: widget.repo.notifications,
        isEmpty: (l) => l.isEmpty,
        emptyMessage: 'No notifications.',
        builder:
            (context, list, _) => ListView.separated(
              itemCount: list.length,
              separatorBuilder: (_, _) => const Divider(height: 1),
              itemBuilder: (context, i) {
                final n = list[i];
                final theme = Theme.of(context);
                return ListTile(
                  leading: Icon(
                    n.read
                        ? Icons.notifications_none
                        : Icons.notifications_active,
                    color:
                        n.read
                            ? theme.colorScheme.outline
                            : theme.colorScheme.primary,
                  ),
                  title: Text(
                    n.description,
                    style:
                        n.read
                            ? null
                            : const TextStyle(fontWeight: FontWeight.w600),
                  ),
                  subtitle:
                      n.createdAt == null
                          ? null
                          : Text(fmtDate.format(n.createdAt!)),
                  onTap: () => _markRead(n),
                );
              },
            ),
      ),
    );
  }
}
