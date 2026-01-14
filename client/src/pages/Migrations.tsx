import { useState, useEffect } from 'react';
import axios from 'axios';
import {
  ArrowRightLeft,
  Plus,
  Play,
  Pause,
  XCircle,
  Trash2,
  CheckCircle,
  Clock,
  AlertCircle,
  X
} from 'lucide-react';

interface Migration {
  id: string;
  name: string;
  source_device_id: string;
  source_device_name: string;
  target_device_id: string;
  target_device_name: string;
  status: string;
  progress: number;
  bytes_transferred: number;
  total_bytes: number;
  files_transferred: number;
  total_files: number;
  error_message: string | null;
  started_at: string | null;
  completed_at: string | null;
  created_at: string;
}

interface Device {
  id: string;
  name: string;
  type: string;
}

interface Export {
  id: string;
  device_id: string;
  export_path: string;
  export_type: string;
}

function Migrations() {
  const [migrations, setMigrations] = useState<Migration[]>([]);
  const [devices, setDevices] = useState<Device[]>([]);
  const [exports, setExports] = useState<Export[]>([]);
  const [loading, setLoading] = useState(true);
  const [showModal, setShowModal] = useState(false);

  const [formData, setFormData] = useState({
    name: '',
    sourceDeviceId: '',
    targetDeviceId: '',
    exportIds: [] as string[],
    targetBasePath: ''
  });

  useEffect(() => {
    fetchData();
    // Poll for updates
    const interval = setInterval(fetchMigrations, 5000);
    return () => clearInterval(interval);
  }, []);

  const fetchData = async () => {
    try {
      const [migrationsRes, devicesRes, exportsRes] = await Promise.all([
        axios.get('/api/migrations'),
        axios.get('/api/devices'),
        axios.get('/api/exports')
      ]);
      setMigrations(migrationsRes.data);
      setDevices(devicesRes.data);
      setExports(exportsRes.data);
    } catch (error) {
      console.error('Failed to fetch data:', error);
    } finally {
      setLoading(false);
    }
  };

  const fetchMigrations = async () => {
    try {
      const response = await axios.get('/api/migrations');
      setMigrations(response.data);
    } catch (error) {
      console.error('Failed to fetch migrations:', error);
    }
  };

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    try {
      await axios.post('/api/migrations', formData);
      setShowModal(false);
      setFormData({
        name: '',
        sourceDeviceId: '',
        targetDeviceId: '',
        exportIds: [],
        targetBasePath: ''
      });
      fetchMigrations();
    } catch (error: any) {
      alert(error.response?.data?.error || 'Failed to create migration');
    }
  };

  const handleStart = async (id: string) => {
    try {
      await axios.post(`/api/migrations/${id}/start`);
      fetchMigrations();
    } catch (error: any) {
      alert(error.response?.data?.error || 'Failed to start migration');
    }
  };

  const handlePause = async (id: string) => {
    try {
      await axios.post(`/api/migrations/${id}/pause`);
      fetchMigrations();
    } catch (error: any) {
      alert(error.response?.data?.error || 'Failed to pause migration');
    }
  };

  const handleCancel = async (id: string) => {
    if (!confirm('Are you sure you want to cancel this migration?')) return;
    try {
      await axios.post(`/api/migrations/${id}/cancel`);
      fetchMigrations();
    } catch (error: any) {
      alert(error.response?.data?.error || 'Failed to cancel migration');
    }
  };

  const handleDelete = async (id: string) => {
    if (!confirm('Are you sure you want to delete this migration?')) return;
    try {
      await axios.delete(`/api/migrations/${id}`);
      fetchMigrations();
    } catch (error: any) {
      alert(error.response?.data?.error || 'Failed to delete migration');
    }
  };

  const formatBytes = (bytes: number) => {
    if (!bytes) return '0 B';
    const sizes = ['B', 'KB', 'MB', 'GB', 'TB'];
    const i = Math.floor(Math.log(bytes) / Math.log(1024));
    return `${(bytes / Math.pow(1024, i)).toFixed(2)} ${sizes[i]}`;
  };

  const getStatusIcon = (status: string) => {
    switch (status) {
      case 'completed':
        return <CheckCircle className="h-6 w-6 text-green-500" />;
      case 'running':
        return <Clock className="h-6 w-6 text-blue-500 animate-pulse" />;
      case 'failed':
        return <AlertCircle className="h-6 w-6 text-red-500" />;
      case 'paused':
        return <Pause className="h-6 w-6 text-yellow-500" />;
      case 'cancelled':
        return <XCircle className="h-6 w-6 text-gray-500" />;
      default:
        return <Clock className="h-6 w-6 text-gray-400" />;
    }
  };

  const getStatusColor = (status: string) => {
    switch (status) {
      case 'completed':
        return 'bg-green-100 text-green-800';
      case 'running':
        return 'bg-blue-100 text-blue-800';
      case 'failed':
        return 'bg-red-100 text-red-800';
      case 'paused':
        return 'bg-yellow-100 text-yellow-800';
      default:
        return 'bg-gray-100 text-gray-800';
    }
  };

  const sourceExports = exports.filter((e) => e.device_id === formData.sourceDeviceId);

  if (loading) {
    return (
      <div className="flex items-center justify-center h-64">
        <div className="animate-spin rounded-full h-12 w-12 border-b-2 border-dell-blue"></div>
      </div>
    );
  }

  return (
    <div>
      <div className="flex items-center justify-between mb-8">
        <div>
          <h1 className="text-2xl font-bold text-gray-900">Migrations</h1>
          <p className="text-gray-600">Manage data migration jobs between storage devices</p>
        </div>
        <button onClick={() => setShowModal(true)} className="btn-primary flex items-center gap-2">
          <Plus className="h-5 w-5" />
          New Migration
        </button>
      </div>

      {migrations.length === 0 ? (
        <div className="card text-center py-12">
          <ArrowRightLeft className="h-16 w-16 mx-auto text-gray-300 mb-4" />
          <h3 className="text-lg font-medium text-gray-900 mb-2">No migrations yet</h3>
          <p className="text-gray-500 mb-4">Create your first migration job to move data between devices</p>
          <button onClick={() => setShowModal(true)} className="btn-primary">
            Create Migration
          </button>
        </div>
      ) : (
        <div className="space-y-4">
          {migrations.map((migration) => (
            <div key={migration.id} className="card">
              <div className="flex items-start justify-between">
                <div className="flex items-start gap-4">
                  {getStatusIcon(migration.status)}
                  <div>
                    <div className="flex items-center gap-2 mb-1">
                      <h3 className="font-semibold text-gray-900">{migration.name}</h3>
                      <span className={`px-2 py-0.5 rounded-full text-xs font-medium ${getStatusColor(migration.status)}`}>
                        {migration.status}
                      </span>
                    </div>
                    <p className="text-sm text-gray-500">
                      {migration.source_device_name} → {migration.target_device_name}
                    </p>
                    <div className="flex items-center gap-4 mt-2 text-sm text-gray-500">
                      <span>{migration.files_transferred || 0} / {migration.total_files || 0} files</span>
                      <span>{formatBytes(migration.bytes_transferred)} / {formatBytes(migration.total_bytes)}</span>
                    </div>
                    {migration.error_message && (
                      <p className="text-sm text-red-600 mt-2">{migration.error_message}</p>
                    )}
                  </div>
                </div>
                <div className="flex items-center gap-2">
                  {migration.status === 'pending' && (
                    <button
                      onClick={() => handleStart(migration.id)}
                      className="btn-primary flex items-center gap-1 text-sm"
                    >
                      <Play className="h-4 w-4" />
                      Start
                    </button>
                  )}
                  {migration.status === 'running' && (
                    <button
                      onClick={() => handlePause(migration.id)}
                      className="btn-secondary flex items-center gap-1 text-sm"
                    >
                      <Pause className="h-4 w-4" />
                      Pause
                    </button>
                  )}
                  {migration.status === 'paused' && (
                    <button
                      onClick={() => handleStart(migration.id)}
                      className="btn-primary flex items-center gap-1 text-sm"
                    >
                      <Play className="h-4 w-4" />
                      Resume
                    </button>
                  )}
                  {['pending', 'running', 'paused'].includes(migration.status) && (
                    <button
                      onClick={() => handleCancel(migration.id)}
                      className="btn-secondary flex items-center gap-1 text-sm text-red-600"
                    >
                      <XCircle className="h-4 w-4" />
                      Cancel
                    </button>
                  )}
                  {['completed', 'failed', 'cancelled'].includes(migration.status) && (
                    <button
                      onClick={() => handleDelete(migration.id)}
                      className="p-2 text-red-600 hover:bg-red-50 rounded-md"
                    >
                      <Trash2 className="h-4 w-4" />
                    </button>
                  )}
                </div>
              </div>

              {/* Progress bar */}
              {migration.status === 'running' && (
                <div className="mt-4">
                  <div className="flex items-center justify-between text-sm mb-1">
                    <span className="text-gray-500">Progress</span>
                    <span className="font-medium">{migration.progress}%</span>
                  </div>
                  <div className="w-full bg-gray-200 rounded-full h-2">
                    <div
                      className="bg-dell-blue h-2 rounded-full transition-all duration-300"
                      style={{ width: `${migration.progress}%` }}
                    ></div>
                  </div>
                </div>
              )}
            </div>
          ))}
        </div>
      )}

      {/* Create Migration Modal */}
      {showModal && (
        <div className="fixed inset-0 bg-black bg-opacity-50 flex items-center justify-center p-4 z-50">
          <div className="bg-white rounded-lg shadow-xl w-full max-w-2xl max-h-[90vh] overflow-auto">
            <div className="flex items-center justify-between p-4 border-b sticky top-0 bg-white">
              <h2 className="text-lg font-semibold">Create Migration Job</h2>
              <button onClick={() => setShowModal(false)} className="text-gray-400 hover:text-gray-600">
                <X className="h-5 w-5" />
              </button>
            </div>
            <form onSubmit={handleSubmit} className="p-4">
              <div className="space-y-4">
                <div>
                  <label className="label">Migration Name</label>
                  <input
                    type="text"
                    value={formData.name}
                    onChange={(e) => setFormData({ ...formData, name: e.target.value })}
                    className="input"
                    placeholder="e.g., Production Data Migration"
                    required
                  />
                </div>

                <div className="grid grid-cols-2 gap-4">
                  <div>
                    <label className="label">Source Device</label>
                    <select
                      value={formData.sourceDeviceId}
                      onChange={(e) => setFormData({ ...formData, sourceDeviceId: e.target.value, exportIds: [] })}
                      className="input"
                      required
                    >
                      <option value="">Select source...</option>
                      {devices.filter((d) => d.type === 'isilon').map((device) => (
                        <option key={device.id} value={device.id}>
                          {device.name} (Isilon)
                        </option>
                      ))}
                    </select>
                  </div>
                  <div>
                    <label className="label">Target Device</label>
                    <select
                      value={formData.targetDeviceId}
                      onChange={(e) => setFormData({ ...formData, targetDeviceId: e.target.value })}
                      className="input"
                      required
                    >
                      <option value="">Select target...</option>
                      {devices.filter((d) => d.type === 'powerscale').map((device) => (
                        <option key={device.id} value={device.id}>
                          {device.name} (PowerScale)
                        </option>
                      ))}
                    </select>
                  </div>
                </div>

                <div>
                  <label className="label">Target Base Path (optional)</label>
                  <input
                    type="text"
                    value={formData.targetBasePath}
                    onChange={(e) => setFormData({ ...formData, targetBasePath: e.target.value })}
                    className="input"
                    placeholder="/ifs/migrated"
                  />
                </div>

                {formData.sourceDeviceId && (
                  <div>
                    <label className="label">Select Exports to Migrate</label>
                    <div className="border rounded-md max-h-48 overflow-auto">
                      {sourceExports.length === 0 ? (
                        <p className="p-4 text-sm text-gray-500 text-center">
                          No exports found. Discover exports from the source device first.
                        </p>
                      ) : (
                        sourceExports.map((exp) => (
                          <label
                            key={exp.id}
                            className="flex items-center gap-3 p-3 hover:bg-gray-50 cursor-pointer border-b last:border-b-0"
                          >
                            <input
                              type="checkbox"
                              checked={formData.exportIds.includes(exp.id)}
                              onChange={(e) => {
                                if (e.target.checked) {
                                  setFormData({ ...formData, exportIds: [...formData.exportIds, exp.id] });
                                } else {
                                  setFormData({ ...formData, exportIds: formData.exportIds.filter((id) => id !== exp.id) });
                                }
                              }}
                              className="rounded border-gray-300"
                            />
                            <span className="font-mono text-sm">{exp.export_path}</span>
                            <span className="text-xs text-gray-500 uppercase">{exp.export_type}</span>
                          </label>
                        ))
                      )}
                    </div>
                  </div>
                )}
              </div>

              <div className="flex justify-end gap-3 mt-6">
                <button type="button" onClick={() => setShowModal(false)} className="btn-secondary">
                  Cancel
                </button>
                <button
                  type="submit"
                  disabled={formData.exportIds.length === 0}
                  className="btn-primary"
                >
                  Create Migration
                </button>
              </div>
            </form>
          </div>
        </div>
      )}
    </div>
  );
}

export default Migrations;
