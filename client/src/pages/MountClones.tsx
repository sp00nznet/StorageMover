import { useState, useEffect } from 'react';
import axios from 'axios';
import {
  Copy,
  Plus,
  RefreshCw,
  Trash2,
  CheckCircle,
  Clock,
  AlertCircle,
  XCircle,
  X,
  Activity,
  Server,
  FolderInput,
  ChevronDown,
  ChevronRight,
  FileText
} from 'lucide-react';

interface MountClone {
  id: string;
  name: string;
  source_type: string;
  source_hostname: string;
  source_path: string;
  target_device_id: string;
  target_device_name: string;
  mount_point: string | null;
  share_name: string | null;
  share_type: string | null;
  status: string;
  error_message: string | null;
  persistent: number;
  created_at: string;
  updated_at: string;
  last_health_check: string | null;
}

interface MountCloneLog {
  id: string;
  level: string;
  message: string;
  details: string | null;
  created_at: string;
}

interface Device {
  id: string;
  name: string;
  type: string;
  hostname: string;
}

interface Export {
  id: string;
  device_id: string;
  export_path: string;
  export_type: string;
  description: string;
}

const SOURCE_TYPES = [
  { value: 'linux_nfs', label: 'Linux NFS', description: 'NFS export from a Linux server' },
  { value: 'linux_smb', label: 'Linux Samba', description: 'SMB/CIFS share from a Linux server' },
  { value: 'windows_smb', label: 'Windows SMB', description: 'SMB share from a Windows server' },
  { value: 'powerscale_nfs', label: 'PowerScale NFS', description: 'NFS export from Dell PowerScale' },
  { value: 'powerscale_smb', label: 'PowerScale SMB', description: 'SMB share from Dell PowerScale' },
  { value: 'isilon_nfs', label: 'Isilon NFS', description: 'NFS export from Dell Isilon' },
  { value: 'isilon_smb', label: 'Isilon SMB', description: 'SMB share from Dell Isilon' }
];

function MountClones() {
  const [clones, setClones] = useState<MountClone[]>([]);
  const [devices, setDevices] = useState<Device[]>([]);
  const [exports, setExports] = useState<Export[]>([]);
  const [loading, setLoading] = useState(true);
  const [showModal, setShowModal] = useState(false);
  const [modalMode, setModalMode] = useState<'manual' | 'fromExport'>('manual');
  const [showLogsModal, setShowLogsModal] = useState(false);
  const [selectedClone, setSelectedClone] = useState<MountClone | null>(null);
  const [cloneLogs, setCloneLogs] = useState<MountCloneLog[]>([]);
  const [expandedClones, setExpandedClones] = useState<Set<string>>(new Set());

  const [formData, setFormData] = useState({
    name: '',
    sourceType: 'linux_nfs',
    sourceHostname: '',
    sourcePath: '',
    sourceUsername: '',
    sourcePassword: '',
    targetDeviceId: '',
    shareName: '',
    shareType: 'smb',
    persistent: true
  });

  const [exportFormData, setExportFormData] = useState({
    exportId: '',
    targetDeviceId: '',
    shareName: '',
    shareType: 'smb',
    persistent: true
  });

  const [stats, setStats] = useState({
    total: 0,
    active: 0,
    pending: 0,
    failed: 0,
    disconnected: 0
  });

  useEffect(() => {
    fetchData();
    const interval = setInterval(fetchClones, 5000);
    return () => clearInterval(interval);
  }, []);

  const fetchData = async () => {
    try {
      const [clonesRes, devicesRes, exportsRes, statsRes] = await Promise.all([
        axios.get('/api/mount-clones'),
        axios.get('/api/devices'),
        axios.get('/api/exports'),
        axios.get('/api/mount-clones/stats/summary')
      ]);
      setClones(clonesRes.data);
      setDevices(devicesRes.data);
      setExports(exportsRes.data);
      setStats(statsRes.data);
    } catch (error) {
      console.error('Failed to fetch data:', error);
    } finally {
      setLoading(false);
    }
  };

  const fetchClones = async () => {
    try {
      const [clonesRes, statsRes] = await Promise.all([
        axios.get('/api/mount-clones'),
        axios.get('/api/mount-clones/stats/summary')
      ]);
      setClones(clonesRes.data);
      setStats(statsRes.data);
    } catch (error) {
      console.error('Failed to fetch clones:', error);
    }
  };

  const fetchCloneLogs = async (cloneId: string) => {
    try {
      const response = await axios.get(`/api/mount-clones/${cloneId}/logs`);
      setCloneLogs(response.data);
    } catch (error) {
      console.error('Failed to fetch logs:', error);
    }
  };

  const handleSubmitManual = async (e: React.FormEvent) => {
    e.preventDefault();
    try {
      await axios.post('/api/mount-clones', formData);
      setShowModal(false);
      resetForm();
      fetchClones();
    } catch (error: any) {
      alert(error.response?.data?.error || 'Failed to create mount clone');
    }
  };

  const handleSubmitFromExport = async (e: React.FormEvent) => {
    e.preventDefault();
    try {
      await axios.post('/api/mount-clones/from-export', exportFormData);
      setShowModal(false);
      resetExportForm();
      fetchClones();
    } catch (error: any) {
      alert(error.response?.data?.error || 'Failed to create mount clone from export');
    }
  };

  const handleRetry = async (id: string) => {
    try {
      await axios.post(`/api/mount-clones/${id}/retry`);
      fetchClones();
    } catch (error: any) {
      alert(error.response?.data?.error || 'Failed to retry');
    }
  };

  const handleDelete = async (id: string) => {
    if (!confirm('Are you sure you want to remove this mount clone?')) return;
    try {
      await axios.delete(`/api/mount-clones/${id}`);
      fetchClones();
    } catch (error: any) {
      alert(error.response?.data?.error || 'Failed to remove');
    }
  };

  const handleHealthCheck = async (id: string) => {
    try {
      await axios.post(`/api/mount-clones/${id}/health-check`);
      fetchClones();
    } catch (error: any) {
      alert(error.response?.data?.error || 'Health check failed');
    }
  };

  const handleViewLogs = async (clone: MountClone) => {
    setSelectedClone(clone);
    await fetchCloneLogs(clone.id);
    setShowLogsModal(true);
  };

  const resetForm = () => {
    setFormData({
      name: '',
      sourceType: 'linux_nfs',
      sourceHostname: '',
      sourcePath: '',
      sourceUsername: '',
      sourcePassword: '',
      targetDeviceId: '',
      shareName: '',
      shareType: 'smb',
      persistent: true
    });
  };

  const resetExportForm = () => {
    setExportFormData({
      exportId: '',
      targetDeviceId: '',
      shareName: '',
      shareType: 'smb',
      persistent: true
    });
  };

  const toggleExpanded = (id: string) => {
    const newExpanded = new Set(expandedClones);
    if (newExpanded.has(id)) {
      newExpanded.delete(id);
    } else {
      newExpanded.add(id);
    }
    setExpandedClones(newExpanded);
  };

  const getStatusIcon = (status: string) => {
    switch (status) {
      case 'active':
        return <CheckCircle className="h-5 w-5 text-green-500" />;
      case 'mounting':
      case 'creating_share':
      case 'pending':
        return <Clock className="h-5 w-5 text-blue-500 animate-pulse" />;
      case 'failed':
        return <AlertCircle className="h-5 w-5 text-red-500" />;
      case 'disconnected':
        return <XCircle className="h-5 w-5 text-yellow-500" />;
      default:
        return <Clock className="h-5 w-5 text-gray-400" />;
    }
  };

  const getStatusColor = (status: string) => {
    switch (status) {
      case 'active':
        return 'bg-green-100 text-green-800';
      case 'mounting':
      case 'creating_share':
      case 'pending':
        return 'bg-blue-100 text-blue-800';
      case 'failed':
        return 'bg-red-100 text-red-800';
      case 'disconnected':
        return 'bg-yellow-100 text-yellow-800';
      default:
        return 'bg-gray-100 text-gray-800';
    }
  };

  const getLogLevelColor = (level: string) => {
    switch (level) {
      case 'error':
        return 'text-red-600 bg-red-50';
      case 'warn':
        return 'text-yellow-600 bg-yellow-50';
      case 'info':
        return 'text-blue-600 bg-blue-50';
      default:
        return 'text-gray-600 bg-gray-50';
    }
  };

  const windowsDevices = devices.filter(d => d.type === 'windows');
  const sourceDevices = devices.filter(d => ['isilon', 'powerscale', 'powerstore', 'windows'].includes(d.type));

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
          <h1 className="text-2xl font-bold text-gray-900">Mount Clones</h1>
          <p className="text-gray-600">Clone and re-export mounts through Windows gateway servers</p>
        </div>
        <button
          onClick={() => {
            setModalMode('manual');
            setShowModal(true);
          }}
          className="btn-primary flex items-center gap-2"
        >
          <Plus className="h-5 w-5" />
          New Clone
        </button>
      </div>

      {/* Stats Cards */}
      <div className="grid grid-cols-5 gap-4 mb-8">
        <div className="card">
          <div className="text-sm text-gray-500">Total Clones</div>
          <div className="text-2xl font-bold">{stats.total}</div>
        </div>
        <div className="card">
          <div className="text-sm text-gray-500">Active</div>
          <div className="text-2xl font-bold text-green-600">{stats.active}</div>
        </div>
        <div className="card">
          <div className="text-sm text-gray-500">Pending</div>
          <div className="text-2xl font-bold text-blue-600">{stats.pending}</div>
        </div>
        <div className="card">
          <div className="text-sm text-gray-500">Disconnected</div>
          <div className="text-2xl font-bold text-yellow-600">{stats.disconnected}</div>
        </div>
        <div className="card">
          <div className="text-sm text-gray-500">Failed</div>
          <div className="text-2xl font-bold text-red-600">{stats.failed}</div>
        </div>
      </div>

      {windowsDevices.length === 0 && (
        <div className="card bg-yellow-50 border-yellow-200 mb-6">
          <div className="flex items-start gap-3">
            <AlertCircle className="h-5 w-5 text-yellow-600 mt-0.5" />
            <div>
              <h3 className="font-medium text-yellow-900">No Windows Gateway Servers</h3>
              <p className="text-sm text-yellow-700 mt-1">
                Add a Windows file server as a device to use mount cloning. Windows servers act as gateways
                to re-export mounted shares.
              </p>
            </div>
          </div>
        </div>
      )}

      {clones.length === 0 ? (
        <div className="card text-center py-12">
          <Copy className="h-16 w-16 mx-auto text-gray-300 mb-4" />
          <h3 className="text-lg font-medium text-gray-900 mb-2">No mount clones yet</h3>
          <p className="text-gray-500 mb-4">
            Clone existing mounts from Linux, Windows, or PowerScale to a Windows gateway server
          </p>
          <div className="flex justify-center gap-3">
            <button
              onClick={() => {
                setModalMode('manual');
                setShowModal(true);
              }}
              className="btn-primary"
            >
              Manual Clone
            </button>
            <button
              onClick={() => {
                setModalMode('fromExport');
                setShowModal(true);
              }}
              className="btn-secondary"
            >
              Clone from Export
            </button>
          </div>
        </div>
      ) : (
        <div className="space-y-4">
          {clones.map((clone) => (
            <div key={clone.id} className="card">
              <div className="flex items-start justify-between">
                <div className="flex items-start gap-4">
                  <button
                    onClick={() => toggleExpanded(clone.id)}
                    className="mt-1 text-gray-400 hover:text-gray-600"
                  >
                    {expandedClones.has(clone.id) ? (
                      <ChevronDown className="h-5 w-5" />
                    ) : (
                      <ChevronRight className="h-5 w-5" />
                    )}
                  </button>
                  {getStatusIcon(clone.status)}
                  <div>
                    <div className="flex items-center gap-2 mb-1">
                      <h3 className="font-semibold text-gray-900">{clone.name}</h3>
                      <span className={`px-2 py-0.5 rounded-full text-xs font-medium ${getStatusColor(clone.status)}`}>
                        {clone.status}
                      </span>
                      <span className="px-2 py-0.5 rounded-full text-xs font-medium bg-gray-100 text-gray-600">
                        {clone.source_type.replace('_', ' ').toUpperCase()}
                      </span>
                    </div>
                    <div className="text-sm text-gray-500 space-y-1">
                      <div className="flex items-center gap-2">
                        <FolderInput className="h-4 w-4" />
                        <span>Source: {clone.source_hostname}:{clone.source_path}</span>
                      </div>
                      <div className="flex items-center gap-2">
                        <Server className="h-4 w-4" />
                        <span>Gateway: {clone.target_device_name}</span>
                        {clone.mount_point && <span className="text-gray-400">({clone.mount_point})</span>}
                      </div>
                      {clone.share_name && (
                        <div className="flex items-center gap-2">
                          <Copy className="h-4 w-4" />
                          <span>Share: {clone.share_name} ({clone.share_type?.toUpperCase()})</span>
                        </div>
                      )}
                    </div>
                    {clone.error_message && (
                      <p className="text-sm text-red-600 mt-2">{clone.error_message}</p>
                    )}
                  </div>
                </div>
                <div className="flex items-center gap-2">
                  <button
                    onClick={() => handleViewLogs(clone)}
                    className="p-2 text-gray-400 hover:text-gray-600 hover:bg-gray-100 rounded-md"
                    title="View Logs"
                  >
                    <FileText className="h-4 w-4" />
                  </button>
                  {clone.status === 'active' && (
                    <button
                      onClick={() => handleHealthCheck(clone.id)}
                      className="p-2 text-gray-400 hover:text-green-600 hover:bg-green-50 rounded-md"
                      title="Health Check"
                    >
                      <Activity className="h-4 w-4" />
                    </button>
                  )}
                  {(clone.status === 'failed' || clone.status === 'disconnected') && (
                    <button
                      onClick={() => handleRetry(clone.id)}
                      className="btn-secondary flex items-center gap-1 text-sm"
                    >
                      <RefreshCw className="h-4 w-4" />
                      Retry
                    </button>
                  )}
                  <button
                    onClick={() => handleDelete(clone.id)}
                    className="p-2 text-red-600 hover:bg-red-50 rounded-md"
                    title="Remove"
                  >
                    <Trash2 className="h-4 w-4" />
                  </button>
                </div>
              </div>

              {/* Expanded Details */}
              {expandedClones.has(clone.id) && (
                <div className="mt-4 pt-4 border-t border-gray-200">
                  <div className="grid grid-cols-2 gap-4 text-sm">
                    <div>
                      <span className="text-gray-500">Created:</span>
                      <span className="ml-2">{new Date(clone.created_at).toLocaleString()}</span>
                    </div>
                    <div>
                      <span className="text-gray-500">Updated:</span>
                      <span className="ml-2">{new Date(clone.updated_at).toLocaleString()}</span>
                    </div>
                    {clone.last_health_check && (
                      <div>
                        <span className="text-gray-500">Last Health Check:</span>
                        <span className="ml-2">{new Date(clone.last_health_check).toLocaleString()}</span>
                      </div>
                    )}
                    <div>
                      <span className="text-gray-500">Persistent:</span>
                      <span className="ml-2">{clone.persistent ? 'Yes' : 'No'}</span>
                    </div>
                  </div>
                </div>
              )}
            </div>
          ))}
        </div>
      )}

      {/* Create Mount Clone Modal */}
      {showModal && (
        <div className="fixed inset-0 bg-black bg-opacity-50 flex items-center justify-center p-4 z-50">
          <div className="bg-white rounded-lg shadow-xl w-full max-w-2xl max-h-[90vh] overflow-auto">
            <div className="flex items-center justify-between p-4 border-b sticky top-0 bg-white">
              <h2 className="text-lg font-semibold">Create Mount Clone</h2>
              <button onClick={() => setShowModal(false)} className="text-gray-400 hover:text-gray-600">
                <X className="h-5 w-5" />
              </button>
            </div>

            {/* Tab Selector */}
            <div className="flex border-b">
              <button
                onClick={() => setModalMode('manual')}
                className={`flex-1 py-3 text-sm font-medium ${
                  modalMode === 'manual'
                    ? 'text-dell-blue border-b-2 border-dell-blue'
                    : 'text-gray-500 hover:text-gray-700'
                }`}
              >
                Manual Configuration
              </button>
              <button
                onClick={() => setModalMode('fromExport')}
                className={`flex-1 py-3 text-sm font-medium ${
                  modalMode === 'fromExport'
                    ? 'text-dell-blue border-b-2 border-dell-blue'
                    : 'text-gray-500 hover:text-gray-700'
                }`}
              >
                From Discovered Export
              </button>
            </div>

            {modalMode === 'manual' ? (
              <form onSubmit={handleSubmitManual} className="p-4">
                <div className="space-y-4">
                  <div>
                    <label className="label">Clone Name</label>
                    <input
                      type="text"
                      value={formData.name}
                      onChange={(e) => setFormData({ ...formData, name: e.target.value })}
                      className="input"
                      placeholder="e.g., Production NFS Clone"
                      required
                    />
                  </div>

                  <div>
                    <label className="label">Source Type</label>
                    <select
                      value={formData.sourceType}
                      onChange={(e) => setFormData({ ...formData, sourceType: e.target.value })}
                      className="input"
                      required
                    >
                      {SOURCE_TYPES.map((type) => (
                        <option key={type.value} value={type.value}>
                          {type.label} - {type.description}
                        </option>
                      ))}
                    </select>
                  </div>

                  <div className="grid grid-cols-2 gap-4">
                    <div>
                      <label className="label">Source Hostname/IP</label>
                      <input
                        type="text"
                        value={formData.sourceHostname}
                        onChange={(e) => setFormData({ ...formData, sourceHostname: e.target.value })}
                        className="input"
                        placeholder="e.g., 192.168.1.100"
                        required
                      />
                    </div>
                    <div>
                      <label className="label">Source Path</label>
                      <input
                        type="text"
                        value={formData.sourcePath}
                        onChange={(e) => setFormData({ ...formData, sourcePath: e.target.value })}
                        className="input"
                        placeholder="e.g., /exports/data or \\share"
                        required
                      />
                    </div>
                  </div>

                  {(formData.sourceType.includes('smb') || formData.sourceType.includes('windows')) && (
                    <div className="grid grid-cols-2 gap-4">
                      <div>
                        <label className="label">Source Username (optional)</label>
                        <input
                          type="text"
                          value={formData.sourceUsername}
                          onChange={(e) => setFormData({ ...formData, sourceUsername: e.target.value })}
                          className="input"
                          placeholder="domain\\user or user"
                        />
                      </div>
                      <div>
                        <label className="label">Source Password (optional)</label>
                        <input
                          type="password"
                          value={formData.sourcePassword}
                          onChange={(e) => setFormData({ ...formData, sourcePassword: e.target.value })}
                          className="input"
                          placeholder="Password"
                        />
                      </div>
                    </div>
                  )}

                  <div>
                    <label className="label">Target Windows Gateway</label>
                    <select
                      value={formData.targetDeviceId}
                      onChange={(e) => setFormData({ ...formData, targetDeviceId: e.target.value })}
                      className="input"
                      required
                    >
                      <option value="">Select Windows server...</option>
                      {windowsDevices.map((device) => (
                        <option key={device.id} value={device.id}>
                          {device.name} ({device.hostname})
                        </option>
                      ))}
                    </select>
                  </div>

                  <div className="grid grid-cols-2 gap-4">
                    <div>
                      <label className="label">Share Name (optional)</label>
                      <input
                        type="text"
                        value={formData.shareName}
                        onChange={(e) => setFormData({ ...formData, shareName: e.target.value })}
                        className="input"
                        placeholder="Auto-generated if empty"
                      />
                    </div>
                    <div>
                      <label className="label">Share Type</label>
                      <select
                        value={formData.shareType}
                        onChange={(e) => setFormData({ ...formData, shareType: e.target.value })}
                        className="input"
                      >
                        <option value="smb">SMB Only</option>
                        <option value="nfs">NFS Only</option>
                        <option value="both">Both SMB and NFS</option>
                      </select>
                    </div>
                  </div>

                  <div className="flex items-center gap-2">
                    <input
                      type="checkbox"
                      id="persistent"
                      checked={formData.persistent}
                      onChange={(e) => setFormData({ ...formData, persistent: e.target.checked })}
                      className="rounded border-gray-300"
                    />
                    <label htmlFor="persistent" className="text-sm text-gray-700">
                      Persistent mount (survives reboots)
                    </label>
                  </div>
                </div>

                <div className="flex justify-end gap-3 mt-6">
                  <button type="button" onClick={() => setShowModal(false)} className="btn-secondary">
                    Cancel
                  </button>
                  <button
                    type="submit"
                    disabled={windowsDevices.length === 0}
                    className="btn-primary"
                  >
                    Create Clone
                  </button>
                </div>
              </form>
            ) : (
              <form onSubmit={handleSubmitFromExport} className="p-4">
                <div className="space-y-4">
                  <div>
                    <label className="label">Select Export to Clone</label>
                    <select
                      value={exportFormData.exportId}
                      onChange={(e) => setExportFormData({ ...exportFormData, exportId: e.target.value })}
                      className="input"
                      required
                    >
                      <option value="">Select an export...</option>
                      {exports.map((exp) => {
                        const device = sourceDevices.find(d => d.id === exp.device_id);
                        return (
                          <option key={exp.id} value={exp.id}>
                            {device?.name}: {exp.export_path} ({exp.export_type.toUpperCase()})
                          </option>
                        );
                      })}
                    </select>
                  </div>

                  <div>
                    <label className="label">Target Windows Gateway</label>
                    <select
                      value={exportFormData.targetDeviceId}
                      onChange={(e) => setExportFormData({ ...exportFormData, targetDeviceId: e.target.value })}
                      className="input"
                      required
                    >
                      <option value="">Select Windows server...</option>
                      {windowsDevices.map((device) => (
                        <option key={device.id} value={device.id}>
                          {device.name} ({device.hostname})
                        </option>
                      ))}
                    </select>
                  </div>

                  <div className="grid grid-cols-2 gap-4">
                    <div>
                      <label className="label">Share Name (optional)</label>
                      <input
                        type="text"
                        value={exportFormData.shareName}
                        onChange={(e) => setExportFormData({ ...exportFormData, shareName: e.target.value })}
                        className="input"
                        placeholder="Auto-generated if empty"
                      />
                    </div>
                    <div>
                      <label className="label">Share Type</label>
                      <select
                        value={exportFormData.shareType}
                        onChange={(e) => setExportFormData({ ...exportFormData, shareType: e.target.value })}
                        className="input"
                      >
                        <option value="smb">SMB Only</option>
                        <option value="nfs">NFS Only</option>
                        <option value="both">Both SMB and NFS</option>
                      </select>
                    </div>
                  </div>

                  <div className="flex items-center gap-2">
                    <input
                      type="checkbox"
                      id="exportPersistent"
                      checked={exportFormData.persistent}
                      onChange={(e) => setExportFormData({ ...exportFormData, persistent: e.target.checked })}
                      className="rounded border-gray-300"
                    />
                    <label htmlFor="exportPersistent" className="text-sm text-gray-700">
                      Persistent mount (survives reboots)
                    </label>
                  </div>

                  <div className="p-3 bg-blue-50 border border-blue-200 rounded-md">
                    <p className="text-xs text-blue-700">
                      <strong>Note:</strong> This will use the credentials from the source device to authenticate
                      when mounting the share on the Windows gateway.
                    </p>
                  </div>
                </div>

                <div className="flex justify-end gap-3 mt-6">
                  <button type="button" onClick={() => setShowModal(false)} className="btn-secondary">
                    Cancel
                  </button>
                  <button
                    type="submit"
                    disabled={windowsDevices.length === 0 || exports.length === 0}
                    className="btn-primary"
                  >
                    Create Clone
                  </button>
                </div>
              </form>
            )}
          </div>
        </div>
      )}

      {/* Logs Modal */}
      {showLogsModal && selectedClone && (
        <div className="fixed inset-0 bg-black bg-opacity-50 flex items-center justify-center p-4 z-50">
          <div className="bg-white rounded-lg shadow-xl w-full max-w-3xl max-h-[80vh] overflow-hidden flex flex-col">
            <div className="flex items-center justify-between p-4 border-b">
              <div>
                <h2 className="text-lg font-semibold">Clone Logs</h2>
                <p className="text-sm text-gray-500">{selectedClone.name}</p>
              </div>
              <button onClick={() => setShowLogsModal(false)} className="text-gray-400 hover:text-gray-600">
                <X className="h-5 w-5" />
              </button>
            </div>

            <div className="flex-1 overflow-auto p-4">
              {cloneLogs.length === 0 ? (
                <p className="text-center text-gray-500 py-8">No logs available</p>
              ) : (
                <div className="space-y-2">
                  {cloneLogs.map((log) => (
                    <div key={log.id} className={`p-3 rounded-md ${getLogLevelColor(log.level)}`}>
                      <div className="flex items-start justify-between">
                        <div className="flex items-center gap-2">
                          <span className="text-xs font-medium uppercase">{log.level}</span>
                          <span className="text-xs text-gray-500">
                            {new Date(log.created_at).toLocaleString()}
                          </span>
                        </div>
                      </div>
                      <p className="text-sm mt-1">{log.message}</p>
                      {log.details && (
                        <pre className="mt-2 text-xs bg-black bg-opacity-10 p-2 rounded overflow-x-auto">
                          {log.details}
                        </pre>
                      )}
                    </div>
                  ))}
                </div>
              )}
            </div>

            <div className="p-4 border-t">
              <button
                onClick={() => fetchCloneLogs(selectedClone.id)}
                className="btn-secondary flex items-center gap-2"
              >
                <RefreshCw className="h-4 w-4" />
                Refresh Logs
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

export default MountClones;
