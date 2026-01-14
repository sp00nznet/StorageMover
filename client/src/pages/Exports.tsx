import { useState, useEffect } from 'react';
import axios from 'axios';
import { FolderOutput, Server, Filter, Trash2 } from 'lucide-react';

interface Export {
  id: string;
  device_id: string;
  device_name: string;
  device_type: string;
  hostname: string;
  export_path: string;
  export_type: 'nfs' | 'smb' | 'both';
  clients: string[];
  permissions: string;
  description: string;
  size_bytes: number;
  discovered_at: string;
}

interface Device {
  id: string;
  name: string;
  type: string;
}

function Exports() {
  const [exports, setExports] = useState<Export[]>([]);
  const [devices, setDevices] = useState<Device[]>([]);
  const [loading, setLoading] = useState(true);
  const [selectedDevice, setSelectedDevice] = useState<string>('');
  const [selectedType, setSelectedType] = useState<string>('');

  useEffect(() => {
    fetchData();
  }, []);

  const fetchData = async () => {
    try {
      const [exportsRes, devicesRes] = await Promise.all([
        axios.get('/api/exports'),
        axios.get('/api/devices')
      ]);
      setExports(exportsRes.data);
      setDevices(devicesRes.data);
    } catch (error) {
      console.error('Failed to fetch data:', error);
    } finally {
      setLoading(false);
    }
  };

  const handleDelete = async (id: string) => {
    if (!confirm('Remove this export from the database?')) return;
    try {
      await axios.delete(`/api/exports/${id}`);
      setExports(exports.filter((e) => e.id !== id));
    } catch (error) {
      alert('Failed to delete export');
    }
  };

  const formatBytes = (bytes: number) => {
    if (!bytes) return 'Unknown';
    const sizes = ['Bytes', 'KB', 'MB', 'GB', 'TB'];
    const i = Math.floor(Math.log(bytes) / Math.log(1024));
    return `${(bytes / Math.pow(1024, i)).toFixed(2)} ${sizes[i]}`;
  };

  const getTypeColor = (type: string) => {
    switch (type) {
      case 'nfs':
        return 'bg-blue-100 text-blue-800';
      case 'smb':
        return 'bg-green-100 text-green-800';
      case 'both':
        return 'bg-purple-100 text-purple-800';
      default:
        return 'bg-gray-100 text-gray-800';
    }
  };

  const filteredExports = exports.filter((exp) => {
    if (selectedDevice && exp.device_id !== selectedDevice) return false;
    if (selectedType && exp.export_type !== selectedType) return false;
    return true;
  });

  if (loading) {
    return (
      <div className="flex items-center justify-center h-64">
        <div className="animate-spin rounded-full h-12 w-12 border-b-2 border-dell-blue"></div>
      </div>
    );
  }

  return (
    <div>
      <div className="mb-8">
        <h1 className="text-2xl font-bold text-gray-900">Network Exports</h1>
        <p className="text-gray-600">Discovered NFS exports and SMB shares from your storage devices</p>
      </div>

      {/* Filters */}
      <div className="card mb-6">
        <div className="flex items-center gap-4">
          <Filter className="h-5 w-5 text-gray-400" />
          <div className="flex-1 grid grid-cols-2 gap-4">
            <div>
              <label className="label">Filter by Device</label>
              <select
                value={selectedDevice}
                onChange={(e) => setSelectedDevice(e.target.value)}
                className="input"
              >
                <option value="">All Devices</option>
                {devices.map((device) => (
                  <option key={device.id} value={device.id}>
                    {device.name} ({device.type})
                  </option>
                ))}
              </select>
            </div>
            <div>
              <label className="label">Filter by Type</label>
              <select
                value={selectedType}
                onChange={(e) => setSelectedType(e.target.value)}
                className="input"
              >
                <option value="">All Types</option>
                <option value="nfs">NFS</option>
                <option value="smb">SMB</option>
                <option value="both">Both</option>
              </select>
            </div>
          </div>
        </div>
      </div>

      {filteredExports.length === 0 ? (
        <div className="card text-center py-12">
          <FolderOutput className="h-16 w-16 mx-auto text-gray-300 mb-4" />
          <h3 className="text-lg font-medium text-gray-900 mb-2">No exports found</h3>
          <p className="text-gray-500">
            {exports.length === 0
              ? 'Discover exports from your storage devices first'
              : 'No exports match your filters'}
          </p>
        </div>
      ) : (
        <div className="space-y-4">
          <p className="text-sm text-gray-500">
            Showing {filteredExports.length} of {exports.length} exports
          </p>

          <div className="grid gap-4">
            {filteredExports.map((exp) => (
              <div key={exp.id} className="card">
                <div className="flex items-start justify-between">
                  <div className="flex-1">
                    <div className="flex items-center gap-2 mb-2">
                      <FolderOutput className="h-5 w-5 text-dell-blue" />
                      <span className="font-mono font-medium text-gray-900">{exp.export_path}</span>
                      <span className={`px-2 py-0.5 rounded-full text-xs font-medium ${getTypeColor(exp.export_type)}`}>
                        {exp.export_type.toUpperCase()}
                      </span>
                    </div>
                    <div className="flex items-center gap-4 text-sm text-gray-500">
                      <span className="flex items-center gap-1">
                        <Server className="h-4 w-4" />
                        {exp.device_name} ({exp.hostname})
                      </span>
                      <span>Size: {formatBytes(exp.size_bytes)}</span>
                      <span>Permissions: {exp.permissions}</span>
                    </div>
                    {exp.clients && exp.clients.length > 0 && (
                      <p className="text-sm text-gray-400 mt-1">
                        Clients: {exp.clients.join(', ')}
                      </p>
                    )}
                    {exp.description && (
                      <p className="text-sm text-gray-500 mt-2">{exp.description}</p>
                    )}
                  </div>
                  <button
                    onClick={() => handleDelete(exp.id)}
                    className="p-2 text-red-600 hover:bg-red-50 rounded-md"
                    title="Remove from database"
                  >
                    <Trash2 className="h-4 w-4" />
                  </button>
                </div>
              </div>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}

export default Exports;
