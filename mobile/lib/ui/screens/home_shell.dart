import 'package:flutter/material.dart';

import '../../auth/auth_controller.dart';
import '../../data/hris_repository.dart';
import 'dtr_screen.dart';
import 'home_screen.dart';
import 'leave_screen.dart';
import 'profile_screen.dart';
import 'records_screen.dart';

/// Staff navigation. Only self-service modules exist here — no HR, supervisor,
/// payroll-processing or admin screens are part of this app.
class HomeShell extends StatefulWidget {
  const HomeShell({super.key, required this.auth, required this.repo});

  final AuthController auth;
  final HrisRepository repo;

  @override
  State<HomeShell> createState() => _HomeShellState();
}

class _HomeShellState extends State<HomeShell> {
  int _index = 0;

  @override
  Widget build(BuildContext context) {
    final pages = [
      HomeScreen(auth: widget.auth, repo: widget.repo, onOpenTab: _go),
      DtrScreen(repo: widget.repo),
      LeaveScreen(repo: widget.repo),
      RecordsScreen(repo: widget.repo),
      ProfileScreen(auth: widget.auth, repo: widget.repo),
    ];
    return Scaffold(
      body: IndexedStack(index: _index, children: pages),
      bottomNavigationBar: NavigationBar(
        selectedIndex: _index,
        onDestinationSelected: _go,
        destinations: const [
          NavigationDestination(
            icon: Icon(Icons.home_outlined),
            selectedIcon: Icon(Icons.home),
            label: 'Home',
          ),
          NavigationDestination(
            icon: Icon(Icons.schedule_outlined),
            selectedIcon: Icon(Icons.schedule),
            label: 'My DTR',
          ),
          NavigationDestination(
            icon: Icon(Icons.event_note_outlined),
            selectedIcon: Icon(Icons.event_note),
            label: 'My Leave',
          ),
          NavigationDestination(
            icon: Icon(Icons.account_balance_wallet_outlined),
            selectedIcon: Icon(Icons.account_balance_wallet),
            label: 'My Records',
          ),
          NavigationDestination(
            icon: Icon(Icons.person_outline),
            selectedIcon: Icon(Icons.person),
            label: 'Profile',
          ),
        ],
      ),
    );
  }

  void _go(int i) => setState(() => _index = i);
}
