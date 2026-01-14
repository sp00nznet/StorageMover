import { useState, useEffect } from 'react';
import { Link } from 'react-router-dom';
import axios from 'axios';
import {
  Server,
  FolderOutput,
  ArrowRightLeft,
  CheckCircle,
  AlertCircle,
  Clock,
  HardDrive
} from 'lucide-react';

interface Stats {
  devices: { total: number; connected: number };
  exports: { total: number; nfs: number; smb: number };
  migrations: { total: number; running: number; completed: number; failed: number };
}

function Dashboard() {
  const [stats, setStats] = useState<Stats | null>(null);
  const [loading, setLoading] = useState(true);
  const [recentMigrations, setRecentMigrations] = useState<any[]>([]);

  useEffect(() => {
    fetchDashboardData();
  }, []);

  const fetchDashboardData = async () => {
    try {
      const [devicesRes, exportsRes, migrationsRes] = await Promise.all([
        axios.get('/api/devices'),
        axios.get('/api/exports/stats/summary'),
        axios.get('/api/migrations')
      ]);

      const devices = devicesRes.data;
      const exportStats = exportsRes.data;
      const migrations = migrationsRes.data;

      setStats({
        devices: {
          total: devices.length,
          connected: devices.filter((d: any) => d.status === 'connected').length
        },
        exports: {
          total: exportStats?.total || 0,
          nfs: exportStats?.nfs || 0,
          smb: exportStats?.smb || 0
        },
        migrations: {
          total: migrations.length,
          running: migrations.filter((m: any) => m.status === 'running').length,
          completed: migrations.filter((m: any) => m.status === 'completed').length,
          failed: migrations.filter((m: any) => m.status === 'failed').length
        }
      });

      setRecentMigrations(migrations.slice(0, 5));
    } catch (error) {
      console.error('Failed to fetch dashboard data:', error);
    } finally {
      setLoading(false);
    }
  };

  if (loading) {
    return (
      <div className="flex items-center justify-center h-64">
        <div className="animate-spin rounded-full h-12 w-12 border-b-2 border-dell-blue"></div>
      </div>
    );
  }

  const statCards = [
    {
      title: 'Storage Devices',
      value: stats?.devices.total || 0,
      subtitle: `${stats?.devices.connected || 0} connected`,
      icon: Server,
      color: 'bg-blue-500',
      link: '/devices'
    },
    {
      title: 'Network Exports',
      value: stats?.exports.total || 0,
      subtitle: `${stats?.exports.nfs || 0} NFS, ${stats?.exports.smb || 0} SMB`,
      icon: FolderOutput,
      color: 'bg-green-500',
      link: '/exports'
    },
    {
      title: 'Migrations',
      value: stats?.migrations.total || 0,
      subtitle: `${stats?.migrations.running || 0} running`,
      icon: ArrowRightLeft,
      color: 'bg-purple-500',
      link: '/migrations'
    },
    {
      title: 'Completed',
      value: stats?.migrations.completed || 0,
      subtitle: `${stats?.migrations.failed || 0} failed`,
      icon: CheckCircle,
      color: 'bg-emerald-500',
      link: '/migrations'
    }
  ];

  const getStatusIcon = (status: string) => {
    switch (status) {
      case 'completed':
        return <CheckCircle className="h-5 w-5 text-green-500" />;
      case 'running':
        return <Clock className="h-5 w-5 text-blue-500 animate-pulse" />;
      case 'failed':
        return <AlertCircle className="h-5 w-5 text-red-500" />;
      default:
        return <Clock className="h-5 w-5 text-gray-400" />;
    }
  };

  return (
    <div>
      <div className="mb-8">
        <h1 className="text-2xl font-bold text-gray-900">Dashboard</h1>
        <p className="text-gray-600">Overview of your storage migration environment</p>
      </div>

      {/* Stats Grid */}
      <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-4 gap-6 mb-8">
        {statCards.map((card) => (
          <Link key={card.title} to={card.link} className="card hover:shadow-lg transition-shadow">
            <div className="flex items-start justify-between">
              <div>
                <p className="text-sm text-gray-600">{card.title}</p>
                <p className="text-3xl font-bold text-gray-900 mt-1">{card.value}</p>
                <p className="text-sm text-gray-500 mt-1">{card.subtitle}</p>
              </div>
              <div className={`p-3 rounded-lg ${card.color}`}>
                <card.icon className="h-6 w-6 text-white" />
              </div>
            </div>
          </Link>
        ))}
      </div>

      {/* Quick Actions & Recent Migrations */}
      <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
        {/* Quick Actions */}
        <div className="card">
          <h2 className="text-lg font-semibold mb-4">Quick Actions</h2>
          <div className="space-y-3">
            <Link
              to="/devices"
              className="flex items-center gap-3 p-3 rounded-lg border border-gray-200 hover:bg-gray-50 transition-colors"
            >
              <Server className="h-5 w-5 text-dell-blue" />
              <div>
                <p className="font-medium">Add Storage Device</p>
                <p className="text-sm text-gray-500">Connect to Isilon, PowerScale, or PowerStore</p>
              </div>
            </Link>
            <Link
              to="/migrations"
              className="flex items-center gap-3 p-3 rounded-lg border border-gray-200 hover:bg-gray-50 transition-colors"
            >
              <ArrowRightLeft className="h-5 w-5 text-dell-blue" />
              <div>
                <p className="font-medium">Create Migration</p>
                <p className="text-sm text-gray-500">Start a new data migration job</p>
              </div>
            </Link>
            <Link
              to="/configuration"
              className="flex items-center gap-3 p-3 rounded-lg border border-gray-200 hover:bg-gray-50 transition-colors"
            >
              <HardDrive className="h-5 w-5 text-dell-blue" />
              <div>
                <p className="font-medium">Export Configuration</p>
                <p className="text-sm text-gray-500">Generate migration scripts</p>
              </div>
            </Link>
          </div>
        </div>

        {/* Recent Migrations */}
        <div className="card">
          <h2 className="text-lg font-semibold mb-4">Recent Migrations</h2>
          {recentMigrations.length === 0 ? (
            <div className="text-center py-8 text-gray-500">
              <ArrowRightLeft className="h-12 w-12 mx-auto mb-2 text-gray-300" />
              <p>No migrations yet</p>
              <Link to="/migrations" className="text-dell-blue hover:underline text-sm">
                Create your first migration
              </Link>
            </div>
          ) : (
            <div className="space-y-3">
              {recentMigrations.map((migration) => (
                <div
                  key={migration.id}
                  className="flex items-center justify-between p-3 rounded-lg border border-gray-200"
                >
                  <div className="flex items-center gap-3">
                    {getStatusIcon(migration.status)}
                    <div>
                      <p className="font-medium">{migration.name}</p>
                      <p className="text-sm text-gray-500">
                        {migration.source_device_name} → {migration.target_device_name}
                      </p>
                    </div>
                  </div>
                  <div className="text-right">
                    <p className="text-sm font-medium">{migration.progress}%</p>
                    <p className="text-xs text-gray-500 capitalize">{migration.status}</p>
                  </div>
                </div>
              ))}
            </div>
          )}
        </div>
      </div>
    </div>
  );
}

export default Dashboard;
