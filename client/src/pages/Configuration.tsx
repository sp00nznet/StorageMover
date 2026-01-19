import { useState, useEffect } from 'react';
import axios from 'axios';
import {
  Settings,
  Download,
  Upload,
  FileCode,
  Server,
  CheckCircle,
  AlertCircle
} from 'lucide-react';

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

interface SavedConfig {
  id: string;
  device_id: string;
  device_name: string;
  config_type: string;
  created_at: string;
}

function Configuration() {
  const [devices, setDevices] = useState<Device[]>([]);
  const [exports, setExports] = useState<Export[]>([]);
  const [savedConfigs, setSavedConfigs] = useState<SavedConfig[]>([]);
  const [loading, setLoading] = useState(true);
  const [generating, setGenerating] = useState(false);
  const [generatedScript, setGeneratedScript] = useState('');

  const [configForm, setConfigForm] = useState({
    targetDeviceId: '',
    sourceDeviceId: '',
    exportIds: [] as string[],
    targetBasePath: '/ifs/migrated',
    nfsSettings: {
      rootSquash: true,
      accessZone: 'System'
    },
    smbSettings: {
      allowGuest: false,
      accessZone: 'System'
    }
  });

  const [windowsForm, setWindowsForm] = useState({
    targetDeviceId: '',
    sourceDeviceId: '',
    exportIds: [] as string[],
    targetBasePath: 'C:\\Shares',
    smbSettings: {
      fullAccess: ['Everyone'],
      changeAccess: [] as string[],
      readAccess: [] as string[],
      noAccess: [] as string[],
      cachingMode: 'Manual',
      encryptData: false
    },
    nfsSettings: {
      allowRootAccess: false,
      enableUnmappedAccess: true
    }
  });

  useEffect(() => {
    fetchData();
  }, []);

  const fetchData = async () => {
    try {
      const [devicesRes, exportsRes, configsRes] = await Promise.all([
        axios.get('/api/devices'),
        axios.get('/api/exports'),
        axios.get('/api/config/saved')
      ]);
      setDevices(devicesRes.data);
      setExports(exportsRes.data);
      setSavedConfigs(configsRes.data);
    } catch (error) {
      console.error('Failed to fetch data:', error);
    } finally {
      setLoading(false);
    }
  };

  const handleGeneratePowerScale = async () => {
    if (!configForm.targetDeviceId || configForm.exportIds.length === 0) {
      alert('Please select a target device and at least one export');
      return;
    }

    setGenerating(true);
    try {
      const response = await axios.post('/api/config/powerscale/generate', configForm);
      setGeneratedScript(response.data.script);
      fetchData(); // Refresh saved configs
    } catch (error: any) {
      alert(error.response?.data?.error || 'Failed to generate configuration');
    } finally {
      setGenerating(false);
    }
  };

  const handleApplyPowerScale = async () => {
    if (!configForm.targetDeviceId || configForm.exportIds.length === 0) {
      alert('Please select a target device and at least one export');
      return;
    }

    if (!confirm('This will apply the configuration directly to the PowerScale device. Continue?')) {
      return;
    }

    setGenerating(true);
    try {
      const response = await axios.post('/api/config/powerscale/apply', configForm);
      if (response.data.success) {
        alert('Configuration applied successfully!');
      } else {
        alert('Some operations failed. Check the results.');
      }
    } catch (error: any) {
      alert(error.response?.data?.error || 'Failed to apply configuration');
    } finally {
      setGenerating(false);
    }
  };

  const handleGenerateWindows = async () => {
    if (!windowsForm.targetDeviceId || windowsForm.exportIds.length === 0) {
      alert('Please select a target Windows server and at least one export');
      return;
    }

    setGenerating(true);
    try {
      const response = await axios.post('/api/config/windows/generate', windowsForm);
      setGeneratedScript(response.data.script);
      fetchData(); // Refresh saved configs
    } catch (error: any) {
      alert(error.response?.data?.error || 'Failed to generate Windows configuration');
    } finally {
      setGenerating(false);
    }
  };

  const handleApplyWindows = async () => {
    if (!windowsForm.targetDeviceId || windowsForm.exportIds.length === 0) {
      alert('Please select a target Windows server and at least one export');
      return;
    }

    if (!confirm('This will create shares directly on the Windows file server. Continue?')) {
      return;
    }

    setGenerating(true);
    try {
      const response = await axios.post('/api/config/windows/apply', windowsForm);
      if (response.data.success) {
        alert('Configuration applied successfully to Windows server!');
      } else {
        alert('Some operations failed. Check the results.');
      }
    } catch (error: any) {
      alert(error.response?.data?.error || 'Failed to apply Windows configuration');
    } finally {
      setGenerating(false);
    }
  };

  const handleExportPowerStore = async (deviceId: string) => {
    setGenerating(true);
    try {
      const response = await axios.post('/api/config/powerstore/export', { deviceId });
      setGeneratedScript(response.data.script);
      fetchData();
    } catch (error: any) {
      alert(error.response?.data?.error || 'Failed to export configuration');
    } finally {
      setGenerating(false);
    }
  };

  const handleDownloadConfig = async (configId: string) => {
    window.open(`/api/config/download/${configId}`, '_blank');
  };

  const copyToClipboard = () => {
    navigator.clipboard.writeText(generatedScript);
    alert('Copied to clipboard!');
  };

  const sourceExports = exports.filter((e) => e.device_id === configForm.sourceDeviceId);
  const windowsSourceExports = exports.filter((e) => e.device_id === windowsForm.sourceDeviceId);
  const powerScaleDevices = devices.filter((d) => d.type === 'powerscale');
  const powerStoreDevices = devices.filter((d) => d.type === 'powerstore');
  const isilonDevices = devices.filter((d) => d.type === 'isilon');
  const windowsDevices = devices.filter((d) => d.type === 'windows');
  const sourceDevices = devices.filter((d) => ['isilon', 'powerscale', 'powerstore'].includes(d.type));

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
        <h1 className="text-2xl font-bold text-gray-900">Configuration</h1>
        <p className="text-gray-600">Generate and export migration configurations for PowerScale, PowerStore, and Windows File Servers</p>
      </div>

      <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
        {/* PowerScale Configuration */}
        <div className="card">
          <div className="flex items-center gap-2 mb-4">
            <Server className="h-5 w-5 text-green-600" />
            <h2 className="text-lg font-semibold">PowerScale Configuration</h2>
          </div>
          <p className="text-sm text-gray-500 mb-4">
            Generate migration scripts to configure exports on PowerScale devices
          </p>

          <div className="space-y-4">
            <div>
              <label className="label">Source Device (Isilon)</label>
              <select
                value={configForm.sourceDeviceId}
                onChange={(e) => setConfigForm({ ...configForm, sourceDeviceId: e.target.value, exportIds: [] })}
                className="input"
              >
                <option value="">Select source...</option>
                {isilonDevices.map((device) => (
                  <option key={device.id} value={device.id}>
                    {device.name}
                  </option>
                ))}
              </select>
            </div>

            <div>
              <label className="label">Target Device (PowerScale)</label>
              <select
                value={configForm.targetDeviceId}
                onChange={(e) => setConfigForm({ ...configForm, targetDeviceId: e.target.value })}
                className="input"
              >
                <option value="">Select target...</option>
                {powerScaleDevices.map((device) => (
                  <option key={device.id} value={device.id}>
                    {device.name}
                  </option>
                ))}
              </select>
            </div>

            <div>
              <label className="label">Target Base Path</label>
              <input
                type="text"
                value={configForm.targetBasePath}
                onChange={(e) => setConfigForm({ ...configForm, targetBasePath: e.target.value })}
                className="input"
                placeholder="/ifs/migrated"
              />
            </div>

            {configForm.sourceDeviceId && (
              <div>
                <label className="label">Select Exports ({configForm.exportIds.length} selected)</label>
                <div className="border rounded-md max-h-40 overflow-auto">
                  {sourceExports.length === 0 ? (
                    <p className="p-3 text-sm text-gray-500 text-center">No exports found</p>
                  ) : (
                    sourceExports.map((exp) => (
                      <label
                        key={exp.id}
                        className="flex items-center gap-3 p-2 hover:bg-gray-50 cursor-pointer border-b last:border-b-0"
                      >
                        <input
                          type="checkbox"
                          checked={configForm.exportIds.includes(exp.id)}
                          onChange={(e) => {
                            if (e.target.checked) {
                              setConfigForm({ ...configForm, exportIds: [...configForm.exportIds, exp.id] });
                            } else {
                              setConfigForm({ ...configForm, exportIds: configForm.exportIds.filter((id) => id !== exp.id) });
                            }
                          }}
                          className="rounded border-gray-300"
                        />
                        <span className="font-mono text-sm">{exp.export_path}</span>
                      </label>
                    ))
                  )}
                </div>
              </div>
            )}

            <div className="grid grid-cols-2 gap-4">
              <label className="flex items-center gap-2">
                <input
                  type="checkbox"
                  checked={configForm.nfsSettings.rootSquash}
                  onChange={(e) =>
                    setConfigForm({
                      ...configForm,
                      nfsSettings: { ...configForm.nfsSettings, rootSquash: e.target.checked }
                    })
                  }
                  className="rounded border-gray-300"
                />
                <span className="text-sm">Root Squash (NFS)</span>
              </label>
              <label className="flex items-center gap-2">
                <input
                  type="checkbox"
                  checked={configForm.smbSettings.allowGuest}
                  onChange={(e) =>
                    setConfigForm({
                      ...configForm,
                      smbSettings: { ...configForm.smbSettings, allowGuest: e.target.checked }
                    })
                  }
                  className="rounded border-gray-300"
                />
                <span className="text-sm">Allow Guest (SMB)</span>
              </label>
            </div>

            <div className="flex gap-2">
              <button
                onClick={handleGeneratePowerScale}
                disabled={generating}
                className="btn-primary flex items-center gap-2 flex-1"
              >
                <FileCode className="h-4 w-4" />
                Generate Script
              </button>
              <button
                onClick={handleApplyPowerScale}
                disabled={generating}
                className="btn-secondary flex items-center gap-2"
              >
                <Upload className="h-4 w-4" />
                Apply Direct
              </button>
            </div>
          </div>
        </div>

        {/* Windows File Server Configuration */}
        <div className="card">
          <div className="flex items-center gap-2 mb-4">
            <Server className="h-5 w-5 text-blue-600" />
            <h2 className="text-lg font-semibold">Windows File Server</h2>
          </div>
          <p className="text-sm text-gray-500 mb-4">
            Export shares from storage devices to Windows file servers with exact configuration
          </p>

          <div className="space-y-4">
            <div>
              <label className="label">Source Device</label>
              <select
                value={windowsForm.sourceDeviceId}
                onChange={(e) => setWindowsForm({ ...windowsForm, sourceDeviceId: e.target.value, exportIds: [] })}
                className="input"
              >
                <option value="">Select source...</option>
                {sourceDevices.map((device) => (
                  <option key={device.id} value={device.id}>
                    {device.name} ({device.type})
                  </option>
                ))}
              </select>
            </div>

            <div>
              <label className="label">Target Windows Server</label>
              <select
                value={windowsForm.targetDeviceId}
                onChange={(e) => setWindowsForm({ ...windowsForm, targetDeviceId: e.target.value })}
                className="input"
              >
                <option value="">Select target...</option>
                {windowsDevices.map((device) => (
                  <option key={device.id} value={device.id}>
                    {device.name}
                  </option>
                ))}
              </select>
            </div>

            <div>
              <label className="label">Target Base Path</label>
              <input
                type="text"
                value={windowsForm.targetBasePath}
                onChange={(e) => setWindowsForm({ ...windowsForm, targetBasePath: e.target.value })}
                className="input"
                placeholder="C:\Shares"
              />
            </div>

            {windowsForm.sourceDeviceId && (
              <div>
                <label className="label">Select Exports ({windowsForm.exportIds.length} selected)</label>
                <div className="border rounded-md max-h-40 overflow-auto">
                  {windowsSourceExports.length === 0 ? (
                    <p className="p-3 text-sm text-gray-500 text-center">No exports found</p>
                  ) : (
                    windowsSourceExports.map((exp) => (
                      <label
                        key={exp.id}
                        className="flex items-center gap-3 p-2 hover:bg-gray-50 cursor-pointer border-b last:border-b-0"
                      >
                        <input
                          type="checkbox"
                          checked={windowsForm.exportIds.includes(exp.id)}
                          onChange={(e) => {
                            if (e.target.checked) {
                              setWindowsForm({ ...windowsForm, exportIds: [...windowsForm.exportIds, exp.id] });
                            } else {
                              setWindowsForm({ ...windowsForm, exportIds: windowsForm.exportIds.filter((id) => id !== exp.id) });
                            }
                          }}
                          className="rounded border-gray-300"
                        />
                        <div className="flex-1">
                          <span className="font-mono text-sm">{exp.export_path}</span>
                          <span className="ml-2 text-xs text-gray-500">({exp.export_type.toUpperCase()})</span>
                        </div>
                      </label>
                    ))
                  )}
                </div>
              </div>
            )}

            <div className="grid grid-cols-2 gap-4">
              <label className="flex items-center gap-2">
                <input
                  type="checkbox"
                  checked={windowsForm.smbSettings.encryptData}
                  onChange={(e) =>
                    setWindowsForm({
                      ...windowsForm,
                      smbSettings: { ...windowsForm.smbSettings, encryptData: e.target.checked }
                    })
                  }
                  className="rounded border-gray-300"
                />
                <span className="text-sm">Encrypt Data (SMB)</span>
              </label>
              <label className="flex items-center gap-2">
                <input
                  type="checkbox"
                  checked={windowsForm.nfsSettings.allowRootAccess}
                  onChange={(e) =>
                    setWindowsForm({
                      ...windowsForm,
                      nfsSettings: { ...windowsForm.nfsSettings, allowRootAccess: e.target.checked }
                    })
                  }
                  className="rounded border-gray-300"
                />
                <span className="text-sm">Allow Root Access (NFS)</span>
              </label>
            </div>

            <div className="flex gap-2">
              <button
                onClick={handleGenerateWindows}
                disabled={generating}
                className="btn-primary flex items-center gap-2 flex-1"
              >
                <FileCode className="h-4 w-4" />
                Generate Script
              </button>
              <button
                onClick={handleApplyWindows}
                disabled={generating}
                className="btn-secondary flex items-center gap-2"
              >
                <Upload className="h-4 w-4" />
                Apply Direct
              </button>
            </div>
          </div>
        </div>

        {/* PowerStore Configuration */}
        <div className="card">
          <div className="flex items-center gap-2 mb-4">
            <Server className="h-5 w-5 text-purple-600" />
            <h2 className="text-lg font-semibold">PowerStore Configuration</h2>
          </div>
          <p className="text-sm text-gray-500 mb-4">
            Export and import configurations for PowerStore devices
          </p>

          {powerStoreDevices.length === 0 ? (
            <div className="text-center py-8 text-gray-500">
              <Server className="h-12 w-12 mx-auto mb-2 text-gray-300" />
              <p>No PowerStore devices configured</p>
            </div>
          ) : (
            <div className="space-y-3">
              {powerStoreDevices.map((device) => (
                <div
                  key={device.id}
                  className="flex items-center justify-between p-3 border rounded-lg"
                >
                  <div>
                    <p className="font-medium">{device.name}</p>
                    <p className="text-sm text-gray-500">PowerStore</p>
                  </div>
                  <button
                    onClick={() => handleExportPowerStore(device.id)}
                    disabled={generating}
                    className="btn-secondary flex items-center gap-1 text-sm"
                  >
                    <Download className="h-4 w-4" />
                    Export Config
                  </button>
                </div>
              ))}
            </div>
          )}
        </div>
      </div>

      {/* Generated Script */}
      {generatedScript && (
        <div className="card mt-6">
          <div className="flex items-center justify-between mb-4">
            <h2 className="text-lg font-semibold">Generated Configuration</h2>
            <button onClick={copyToClipboard} className="btn-secondary text-sm">
              Copy to Clipboard
            </button>
          </div>
          <pre className="bg-gray-900 text-gray-100 p-4 rounded-lg overflow-auto max-h-96 text-sm font-mono">
            {generatedScript}
          </pre>
        </div>
      )}

      {/* Saved Configurations */}
      {savedConfigs.length > 0 && (
        <div className="card mt-6">
          <h2 className="text-lg font-semibold mb-4">Saved Configurations</h2>
          <div className="space-y-2">
            {savedConfigs.map((config) => (
              <div
                key={config.id}
                className="flex items-center justify-between p-3 border rounded-lg"
              >
                <div>
                  <p className="font-medium">{config.device_name}</p>
                  <p className="text-sm text-gray-500">
                    {config.config_type} - {new Date(config.created_at).toLocaleString()}
                  </p>
                </div>
                <button
                  onClick={() => handleDownloadConfig(config.id)}
                  className="btn-secondary flex items-center gap-1 text-sm"
                >
                  <Download className="h-4 w-4" />
                  Download
                </button>
              </div>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}

export default Configuration;
