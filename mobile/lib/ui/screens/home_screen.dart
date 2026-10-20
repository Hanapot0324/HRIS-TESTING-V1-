import 'package:flutter/material.dart';

import '../../auth/auth_controller.dart';
import '../../data/hris_repository.dart';
import '../../data/models.dart';
import '../theme.dart';
import '../widgets/async_body.dart';
import 'notifications_screen.dart';

class _HomeData {
  const _HomeData(
    this.balances,
    this.requests,
    this.announcements,
    this.unread,
  );

  final List<LeaveBalance> balances;
  final List<LeaveRequest> requests;
  final List<Announcement> announcements;
  final int unread;
}

class HomeScreen extends StatefulWidget {
  const HomeScreen({
    super.key,
    required this.auth,
    required this.repo,
    required this.onOpenTab,
  });

  final AuthController auth;
  final HrisRepository repo;
  final void Function(int tab) onOpenTab;

  @override
  State<HomeScreen> createState() => _HomeScreenState();
}

class _HomeScreenState extends State<HomeScreen> {
  final _bodyKey = GlobalKey<AsyncBodyState<_HomeData>>();

  Future<_HomeData> _load() async {
    final r = widget.repo;
    final results = await Future.wait([
      r.leaveBalances(),
      r.leaveRequests(),
      r.announcements(),
      r.notifications(),
    ]);
    final notifications = results[3] as List<AppNotification>;
    return _HomeData(
      results[0] as List<LeaveBalance>,
      results[1] as List<LeaveRequest>,
      results[2] as List<Announcement>,
      notifications.where((n) => !n.read).length,
    );
  }

  Future<void> _openNotifications() async {
    await Navigator.of(context).push(
      MaterialPageRoute<void>(
        builder: (_) => NotificationsScreen(repo: widget.repo),
      ),
    );
    await _bodyKey.currentState?.reload();
  }

  @override
  Widget build(BuildContext context) {
    final session = widget.auth.session;
    return Scaffold(
      appBar: AppBar(
        title: const Text('EARIST HRIS'),
        actions: [
          IconButton(
            tooltip: 'Notifications',
            icon: const Icon(Icons.notifications_outlined),
            onPressed: _openNotifications,
          ),
        ],
      ),
      body: AsyncBody<_HomeData>(
        key: _bodyKey,
        load: _load,
        builder: (context, d, _) {
          final theme = Theme.of(context);
          final pending =
              d.requests.where((q) => q.status == LeaveStatus.pending).length;
          return ListView(
            padding: const EdgeInsets.all(16),
            children: [
              Text(
                'Hello, ${orDash(session?.displayName)}',
                style: theme.textTheme.headlineSmall,
              ),
              Text(
                'Employee no. ${orDash(session?.employeeNumber)}',
                style: theme.textTheme.bodyMedium,
              ),
              if (session?.isDefaultPassword ?? false) ...[
                const SizedBox(height: 12),
                Card(
                  color: theme.colorScheme.errorContainer,
                  child: const ListTile(
                    leading: Icon(Icons.warning_amber_outlined),
                    title: Text('You are using a default password'),
                    subtitle: Text(
                      'Change it on the HRIS web portal (Settings).',
                    ),
                  ),
                ),
              ],
              const SizedBox(height: 16),
              Row(
                children: [
                  Expanded(
                    child: _StatCard(
                      icon: Icons.notifications_active_outlined,
                      label: 'Unread notifications',
                      value: '${d.unread}',
                      onTap: _openNotifications,
                    ),
                  ),
                  const SizedBox(width: 12),
                  Expanded(
                    child: _StatCard(
                      icon: Icons.hourglass_top_outlined,
                      label: 'Pending leave days',
                      value: '$pending',
                      onTap: () => widget.onOpenTab(2),
                    ),
                  ),
                ],
              ),
              const SizedBox(height: 12),
              Card(
                child: ListTile(
                  leading: const Icon(Icons.schedule),
                  title: const Text('My Daily Time Record'),
                  subtitle: const Text('View this period’s attendance'),
                  trailing: const Icon(Icons.chevron_right),
                  onTap: () => widget.onOpenTab(1),
                ),
              ),
              const SizedBox(height: 20),
              _SectionTitle(
                'Leave balances',
                onMore: () => widget.onOpenTab(2),
              ),
              if (d.balances.isEmpty)
                const Padding(
                  padding: EdgeInsets.symmetric(vertical: 8),
                  child: Text('No leave credits are assigned to you.'),
                )
              else
                ...d.balances
                    .take(3)
                    .map(
                      (b) => Card(
                        child: ListTile(
                          title: Text(b.description ?? b.leaveCode),
                          subtitle: Text(b.leaveCode),
                          trailing: Text(
                            '${fmtHours(b.remainingHours)} left',
                            style: theme.textTheme.titleSmall,
                          ),
                        ),
                      ),
                    ),
              const SizedBox(height: 20),
              const _SectionTitle('Announcements'),
              if (d.announcements.isEmpty)
                const Padding(
                  padding: EdgeInsets.symmetric(vertical: 8),
                  child: Text('No announcements.'),
                )
              else
                ...d.announcements
                    .take(5)
                    .map(
                      (a) => Card(
                        child: ListTile(
                          leading: const Icon(Icons.campaign_outlined),
                          title: Text(a.title),
                          subtitle: Text(
                            [
                              if (a.dateStart != null)
                                _range(a.dateStart!, a.dateEnd),
                              if (a.about != null) a.about!,
                            ].join('\n'),
                          ),
                          isThreeLine: a.about != null && a.dateStart != null,
                        ),
                      ),
                    ),
            ],
          );
        },
      ),
    );
  }

  static String _range(DateTime start, DateTime? end) {
    if (end == null || DateUtils.isSameDay(start, end)) {
      return fmtDate.format(start);
    }
    return '${fmtDate.format(start)} – ${fmtDate.format(end)}';
  }
}

class _StatCard extends StatelessWidget {
  const _StatCard({
    required this.icon,
    required this.label,
    required this.value,
    this.onTap,
  });

  final IconData icon;
  final String label;
  final String value;
  final VoidCallback? onTap;

  @override
  Widget build(BuildContext context) {
    final theme = Theme.of(context);
    return Card(
      clipBehavior: Clip.antiAlias,
      child: InkWell(
        onTap: onTap,
        child: Padding(
          padding: const EdgeInsets.all(16),
          child: Column(
            crossAxisAlignment: CrossAxisAlignment.start,
            children: [
              Icon(icon, color: theme.colorScheme.primary),
              const SizedBox(height: 8),
              Text(value, style: theme.textTheme.headlineSmall),
              Text(label, style: theme.textTheme.bodySmall),
            ],
          ),
        ),
      ),
    );
  }
}

class _SectionTitle extends StatelessWidget {
  const _SectionTitle(this.title, {this.onMore});

  final String title;
  final VoidCallback? onMore;

  @override
  Widget build(BuildContext context) => Padding(
    padding: const EdgeInsets.only(bottom: 8),
    child: Row(
      children: [
        Expanded(
          child: Text(title, style: Theme.of(context).textTheme.titleMedium),
        ),
        if (onMore != null)
          TextButton(onPressed: onMore, child: const Text('See all')),
      ],
    ),
  );
}
