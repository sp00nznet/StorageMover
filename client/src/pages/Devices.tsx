import { useState, useEffect } from 'react';
import axios from 'axios';
import {
  Server,
  Plus,
  Trash2,
  RefreshCw,
  CheckCircle,
  XCircle,
  Wifi,
  Search,
  X
} from 'lucide-react';

interface Device {
  id: string;
  name: string;
  type: 'isilon' | 'powerscale' | 'powerstore';
  hostname: string;
  port: number;
  username: string;
  status: string;
  last_connected: string | null;
}

function Devices() {
  const [devices, setDevices] = useState<Device[]>([]);
  const [loading, setLoading] = useState(true);
  const [showModal, setShowModal] = useState(false);
  const [testingDevice, setTestingDevice] = useState<string | null>(null);
  const [discoveringDevice, setDiscoveringDevice] = useState<string | null>(null);

  const [formData, setFormData] = useState({
    name: '',
    type: 'isilon' as 'isilon' | 'powerscale' | 'powerstore',
    hostname: '',
    port: '8080',
    username: '',
    password: ''
  });

  useEffect(() => {
    fetchDevices();
  }, []);

  const fetchDevices = async () => {
    try {
      const response = await axios.get('/api/devices');
      setDevices(response.data);
    } catch (error) {
      console.error('Failed to fetch devices:', error);
    } finally {
      setLoading(false);
    }
  };

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    try {
      await axios.post('/api/devices', {
        ...formData,
        port: parseInt(formData.port)
      });
      setShowModal(false);
      setFormData({
        name: '',
        type: 'isilon',
        hostname: '',
        port: '8080',
        username: '',
        password: ''
      });
      fetchDevices();
    } catch (error: any) {
      alert(error.response?.data?.error || 'Failed to add device');
    }
  };

  const handleDelete = async (id: string) => {
    if (!confirm('Are you sure you want to delete this device?')) return;
    try {
      await axios.delete(`/api/devices/${id}`);
      fetchDevices();
    } catch (error) {
      alert('Failed to delete device');
    }
  };

  const handleTest = async (id: string) => {
    setTestingDevice(id);
    try {
      const response = await axios.post(`/api/devices/${id}/test`);
      if (response.data.success) {
        alert('Connection successful!');
      } else {
        alert('Connection failed: ' + response.data.message);
      }
      fetchDevices();
    } catch (error: any) {
      alert('Connection test failed: ' + (error.response?.data?.details || error.message));
    } finally {
      setTestingDevice(null);
    }
  };

  const handleDiscover = async (id: string) => {
    setDiscoveringDevice(id);
    try {
      const response = await axios.post(`/api/devices/${id}/discover`);
      alert(`Discovered ${response.data.count} exports!`);
    } catch (error: any) {
      alert('Discovery failed: ' + (error.response?.data?.details || error.message));
    } finally {
      setDiscoveringDevice(null);
    }
  };

  const getDeviceTypeColor = (type: string) => {
    switch (type) {
      case 'isilon':
        return 'bg-blue-100 text-blue-800';
      case 'powerscale':
        return 'bg-green-100 text-green-800';
      case 'powerstore':
        return 'bg-purple-100 text-purple-800';
      default:
        return 'bg-gray-100 text-gray-800';
    }
  };

  const getStatusIcon = (status: string) => {
    switch (status) {
      case 'connected':
        return <CheckCircle className="h-5 w-5 text-green-500" />;
      case 'failed':
        return <XCircle className="h-5 w-5 text-red-500" />;
      default:
        return <Wifi className="h-5 w-5 text-gray-400" />;
    }
  };

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
          <h1 className="text-2xl font-bold text-gray-900">Storage Devices</h1>
          <p className="text-gray-600">Manage your Isilon, PowerScale, and PowerStore devices</p>
        </div>
        <button onClick={() => setShowModal(true)} className="btn-primary flex items-center gap-2">
          <Plus className="h-5 w-5" />
          Add Device
        </button>
      </div>

      {devices.length === 0 ? (
        <div className="card text-center py-12">
          <Server className="h-16 w-16 mx-auto text-gray-300 mb-4" />
          <h3 className="text-lg font-medium text-gray-900 mb-2">No devices configured</h3>
          <p className="text-gray-500 mb-4">Add your first storage device to get started</p>
          <button onClick={() => setShowModal(true)} className="btn-primary">
            Add Device
          </button>
        </div>
      ) : (
        <div className="grid gap-4">
          {devices.map((device) => (
            <div key={device.id} className="card">
              <div className="flex items-center justify-between">
                <div className="flex items-center gap-4">
                  {getStatusIcon(device.status)}
                  <div>
                    <div className="flex items-center gap-2">
                      <h3 className="font-semibold text-gray-900">{device.name}</h3>
                      <span className={`px-2 py-0.5 rounded-full text-xs font-medium ${getDeviceTypeColor(device.type)}`}>
                        {device.type.toUpperCase()}
                      </span>
                    </div>
                    <p className="text-sm text-gray-500">
                      {device.hostname}:{device.port} ({device.username})
                    </p>
                    {device.last_connected && (
                      <p className="text-xs text-gray-400">
                        Last connected: {new Date(device.last_connected).toLocaleString()}
                      </p>
                    )}
                  </div>
                </div>
                <div className="flex items-center gap-2">
                  <button
                    onClick={() => handleTest(device.id)}
                    disabled={testingDevice === device.id}
                    className="btn-secondary flex items-center gap-1 text-sm"
                    title="Test Connection"
                  >
                    <RefreshCw className={`h-4 w-4 ${testingDevice === device.id ? 'animate-spin' : ''}`} />
                    Test
                  </button>
                  <button
                    onClick={() => handleDiscover(device.id)}
                    disabled={discoveringDevice === device.id}
                    className="btn-secondary flex items-center gap-1 text-sm"
                    title="Discover Exports"
                  >
                    <Search className={`h-4 w-4 ${discoveringDevice === device.id ? 'animate-pulse' : ''}`} />
                    Discover
                  </button>
                  <button
                    onClick={() => handleDelete(device.id)}
                    className="p-2 text-red-600 hover:bg-red-50 rounded-md"
                    title="Delete Device"
                  >
                    <Trash2 className="h-4 w-4" />
                  </button>
                </div>
              </div>
            </div>
          ))}
        </div>
      )}

      {/* Add Device Modal */}
      {showModal && (
        <div className="fixed inset-0 bg-black bg-opacity-50 flex items-center justify-center p-4 z-50">
          <div className="bg-white rounded-lg shadow-xl w-full max-w-md">
            <div className="flex items-center justify-between p-4 border-b">
              <h2 className="text-lg font-semibold">Add Storage Device</h2>
              <button onClick={() => setShowModal(false)} className="text-gray-400 hover:text-gray-600">
                <X className="h-5 w-5" />
              </button>
            </div>
            <form onSubmit={handleSubmit} className="p-4">
              <div className="space-y-4">
                <div>
                  <label className="label">Device Name</label>
                  <input
                    type="text"
                    value={formData.name}
                    onChange={(e) => setFormData({ ...formData, name: e.target.value })}
                    className="input"
                    placeholder="e.g., Production Isilon"
                    required
                  />
                </div>
                <div>
                  <label className="label">Device Type</label>
                  <select
                    value={formData.type}
                    onChange={(e) => setFormData({ ...formData, type: e.target.value as any })}
                    className="input"
                  >
                    <option value="isilon">Dell EMC Isilon</option>
                    <option value="powerscale">Dell PowerScale</option>
                    <option value="powerstore">Dell PowerStore</option>
                  </select>
                </div>
                <div className="grid grid-cols-3 gap-4">
                  <div className="col-span-2">
                    <label className="label">Hostname / IP</label>
                    <input
                      type="text"
                      value={formData.hostname}
                      onChange={(e) => setFormData({ ...formData, hostname: e.target.value })}
                      className="input"
                      placeholder="192.168.1.100"
                      required
                    />
                  </div>
                  <div>
                    <label className="label">Port</label>
                    <input
                      type="number"
                      value={formData.port}
                      onChange={(e) => setFormData({ ...formData, port: e.target.value })}
                      className="input"
                      placeholder="8080"
                    />
                  </div>
                </div>
                <div>
                  <label className="label">Username</label>
                  <input
                    type="text"
                    value={formData.username}
                    onChange={(e) => setFormData({ ...formData, username: e.target.value })}
                    className="input"
                    placeholder="admin"
                    required
                  />
                </div>
                <div>
                  <label className="label">Password</label>
                  <input
                    type="password"
                    value={formData.password}
                    onChange={(e) => setFormData({ ...formData, password: e.target.value })}
                    className="input"
                    placeholder="Enter password"
                    required
                  />
                </div>
              </div>
              <div className="flex justify-end gap-3 mt-6">
                <button type="button" onClick={() => setShowModal(false)} className="btn-secondary">
                  Cancel
                </button>
                <button type="submit" className="btn-primary">
                  Add Device
                </button>
              </div>
            </form>
          </div>
        </div>
      )}
    </div>
  );
}

export default Devices;
