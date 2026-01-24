import { exec } from 'child_process';
import { promisify } from 'util';
import { logger } from '../utils/logger';

const execAsync = promisify(exec);

export interface WindowsShare {
  name: string;
  path: string;
  type: 'nfs' | 'smb' | 'both';
  description: string;
  permissions: any;
}

export type MountSourceType = 'linux_nfs' | 'linux_smb' | 'windows_smb' | 'powerscale_nfs' | 'powerscale_smb' | 'isilon_nfs' | 'isilon_smb';

export interface MountCloneConfig {
  name: string;
  sourceType: MountSourceType;
  sourceHostname: string;
  sourcePath: string;
  sourceUsername?: string;
  sourcePassword?: string;
  shareName?: string;
  shareType?: 'nfs' | 'smb' | 'both';
  persistent?: boolean;
  smbSettings?: WindowsExportConfig['smbSettings'];
  nfsSettings?: WindowsExportConfig['nfsSettings'];
}

export interface MountCloneResult {
  success: boolean;
  mountPoint?: string;
  shareName?: string;
  shareType?: 'nfs' | 'smb' | 'both';
  error?: string;
  logs: MountCloneLog[];
}

export interface MountCloneLog {
  level: 'info' | 'warn' | 'error' | 'debug';
  message: string;
  details?: string;
  timestamp: Date;
}

export interface MountHealthStatus {
  accessible: boolean;
  mountPoint: string;
  remotePath: string;
  shareActive: boolean;
  lastChecked: Date;
  error?: string;
}

export interface MountConfig {
  sourceHostname: string;
  sourcePath: string;
  sourceType: 'nfs' | 'smb';
  sourceUsername?: string;
  sourcePassword?: string;
  mountPoint?: string; // e.g., "Z:", if not provided will auto-assign
  persistent?: boolean; // Mount survives reboots
}

export interface WindowsExportConfig {
  sourceExports: {
    path: string;
    type: 'nfs' | 'smb' | 'both';
    clients?: string[];
    permissions?: string;
    description?: string;
  }[];
  targetBasePath: string;
  smbSettings: {
    fullAccess?: string[];
    changeAccess?: string[];
    readAccess?: string[];
    noAccess?: string[];
    cachingMode?: 'None' | 'Manual' | 'Documents' | 'Programs' | 'BranchCache';
    encryptData?: boolean;
  };
  nfsSettings?: {
    allowRootAccess?: boolean;
    enableUnmappedAccess?: boolean;
    anonymousUid?: number;
    anonymousGid?: number;
    authentication?: string[];
  };
}

export class WindowsFileServerClient {
  private hostname: string;
  private port: number;
  private username: string;
  private password: string;
  private domain: string;

  constructor(hostname: string, port: number, username: string, password: string) {
    this.hostname = hostname;
    this.port = port || 5985; // Default WinRM HTTP port

    // Parse domain\username or username@domain format
    if (username.includes('\\')) {
      const parts = username.split('\\');
      this.domain = parts[0];
      this.username = parts[1];
    } else if (username.includes('@')) {
      const parts = username.split('@');
      this.username = parts[0];
      this.domain = parts[1];
    } else {
      this.username = username;
      this.domain = '';
    }

    this.password = password;
  }

  /**
   * Execute PowerShell command on remote Windows server using WinRM
   */
  private async executePowerShell(command: string): Promise<string> {
    // Escape special characters in password
    const escapedPassword = this.password
      .replace(/\\/g, '\\\\')
      .replace(/"/g, '\\"')
      .replace(/'/g, "\\'")
      .replace(/\$/g, '\\$')
      .replace(/`/g, '\\`');

    // Build credential string
    const credString = this.domain
      ? `${this.domain}\\${this.username}`
      : this.username;

    // PowerShell script to execute remote command
    const psScript = `
$securePassword = ConvertTo-SecureString "${escapedPassword}" -AsPlainText -Force
$credential = New-Object System.Management.Automation.PSCredential("${credString}", $securePassword)
$sessionOptions = New-PSSessionOption -SkipCACheck -SkipCNCheck -SkipRevocationCheck
try {
  Invoke-Command -ComputerName ${this.hostname} -Port ${this.port} -Credential $credential -SessionOption $sessionOptions -ScriptBlock {
    ${command}
  } -ErrorAction Stop
} catch {
  Write-Error $_.Exception.Message
  exit 1
}
    `.trim();

    try {
      // Execute via PowerShell on the host system (requires pwsh or powershell.exe)
      const { stdout, stderr } = await execAsync(
        `pwsh -NoProfile -NonInteractive -Command "${psScript.replace(/"/g, '\\"')}"`,
        { maxBuffer: 10 * 1024 * 1024 } // 10MB buffer
      );

      if (stderr && stderr.includes('Error')) {
        throw new Error(stderr);
      }

      return stdout.trim();
    } catch (error: any) {
      logger.error(`PowerShell execution failed on ${this.hostname}:`, error.message);
      throw error;
    }
  }

  /**
   * Test connection to Windows file server
   */
  async testConnection(): Promise<boolean> {
    try {
      const result = await this.executePowerShell('$env:COMPUTERNAME');
      logger.info(`Connected to Windows server: ${result}`);
      return true;
    } catch (error: any) {
      logger.error(`Windows file server connection test failed:`, error.message);
      return false;
    }
  }

  /**
   * Get Windows server information
   */
  async getServerInfo(): Promise<any> {
    try {
      const command = `
        $os = Get-CimInstance Win32_OperatingSystem
        $computer = Get-CimInstance Win32_ComputerSystem
        @{
          ComputerName = $computer.Name
          Domain = $computer.Domain
          OSName = $os.Caption
          OSVersion = $os.Version
          TotalMemoryGB = [math]::Round($computer.TotalPhysicalMemory / 1GB, 2)
        } | ConvertTo-Json -Compress
      `;

      const result = await this.executePowerShell(command);
      return JSON.parse(result);
    } catch (error: any) {
      logger.error('Failed to get Windows server info:', error.message);
      throw error;
    }
  }

  /**
   * Create directory on Windows server
   */
  async createDirectory(path: string): Promise<boolean> {
    try {
      const command = `
        if (!(Test-Path "${path}")) {
          New-Item -Path "${path}" -ItemType Directory -Force | Out-Null
          Write-Output "Created directory: ${path}"
        } else {
          Write-Output "Directory already exists: ${path}"
        }
      `;

      await this.executePowerShell(command);
      logger.info(`Created directory ${path} on Windows server ${this.hostname}`);
      return true;
    } catch (error: any) {
      logger.error(`Failed to create directory ${path}:`, error.message);
      return false;
    }
  }

  /**
   * Create SMB share on Windows file server
   */
  async createSmbShare(
    shareName: string,
    path: string,
    description: string = '',
    options: WindowsExportConfig['smbSettings'] = {}
  ): Promise<any> {
    try {
      // Build the New-SmbShare command with all options
      let command = `
        # Check if share already exists
        $existingShare = Get-SmbShare -Name "${shareName}" -ErrorAction SilentlyContinue
        if ($existingShare) {
          Remove-SmbShare -Name "${shareName}" -Force
        }

        # Create the SMB share
        $shareParams = @{
          Name = "${shareName}"
          Path = "${path}"
          Description = "${description}"
      `;

      if (options.fullAccess && options.fullAccess.length > 0) {
        command += `\n          FullAccess = @(${options.fullAccess.map(u => `"${u}"`).join(', ')})`;
      } else {
        command += `\n          FullAccess = "Everyone"`;
      }

      if (options.changeAccess && options.changeAccess.length > 0) {
        command += `\n          ChangeAccess = @(${options.changeAccess.map(u => `"${u}"`).join(', ')})`;
      }

      if (options.readAccess && options.readAccess.length > 0) {
        command += `\n          ReadAccess = @(${options.readAccess.map(u => `"${u}"`).join(', ')})`;
      }

      if (options.noAccess && options.noAccess.length > 0) {
        command += `\n          NoAccess = @(${options.noAccess.map(u => `"${u}"`).join(', ')})`;
      }

      if (options.cachingMode) {
        command += `\n          CachingMode = "${options.cachingMode}"`;
      }

      if (options.encryptData !== undefined) {
        command += `\n          EncryptData = $${options.encryptData}`;
      }

      command += `
        }

        New-SmbShare @shareParams -ErrorAction Stop

        Write-Output "Successfully created SMB share: ${shareName}"
      `;

      const result = await this.executePowerShell(command);
      logger.info(`Created SMB share ${shareName} on Windows server ${this.hostname}`);
      return { success: true, message: result };
    } catch (error: any) {
      logger.error(`Failed to create SMB share ${shareName}:`, error.message);
      throw error;
    }
  }

  /**
   * Create NFS share on Windows file server (requires NFS Server feature)
   */
  async createNfsShare(
    path: string,
    options: WindowsExportConfig['nfsSettings'] = {}
  ): Promise<any> {
    try {
      let command = `
        # Check if NFS Server feature is installed
        $nfsFeature = Get-WindowsFeature -Name FS-NFS-Service -ErrorAction SilentlyContinue
        if (!$nfsFeature -or !$nfsFeature.Installed) {
          throw "NFS Server feature is not installed. Install it with: Install-WindowsFeature -Name FS-NFS-Service"
        }

        # Remove existing NFS share if it exists
        $existingShare = Get-NfsShare -Path "${path}" -ErrorAction SilentlyContinue
        if ($existingShare) {
          Remove-NfsShare -Path "${path}" -Force
        }

        # Create NFS share
        $nfsParams = @{
          Name = "${path}"
          Path = "${path}"
          EnableUnmappedAccess = $${options.enableUnmappedAccess !== false}
      `;

      if (options.allowRootAccess !== undefined) {
        command += `\n          AllowRootAccess = $${options.allowRootAccess}`;
      }

      if (options.anonymousUid !== undefined) {
        command += `\n          AnonymousUid = ${options.anonymousUid}`;
      }

      if (options.anonymousGid !== undefined) {
        command += `\n          AnonymousGid = ${options.anonymousGid}`;
      }

      if (options.authentication && options.authentication.length > 0) {
        command += `\n          Authentication = @(${options.authentication.map(a => `"${a}"`).join(', ')})`;
      }

      command += `
        }

        New-NfsShare @nfsParams -ErrorAction Stop

        # Grant access to all clients by default
        Grant-NfsSharePermission -Name "${path}" -ClientName "*" -ClientType "host" -Permission "readwrite" -ErrorAction SilentlyContinue

        Write-Output "Successfully created NFS share: ${path}"
      `;

      const result = await this.executePowerShell(command);
      logger.info(`Created NFS share ${path} on Windows server ${this.hostname}`);
      return { success: true, message: result };
    } catch (error: any) {
      logger.error(`Failed to create NFS share ${path}:`, error.message);
      throw error;
    }
  }

  /**
   * List existing SMB shares
   */
  async listSmbShares(): Promise<any[]> {
    try {
      const command = `
        Get-SmbShare | Where-Object { $_.Special -eq $false } | Select-Object Name, Path, Description | ConvertTo-Json -Compress
      `;

      const result = await this.executePowerShell(command);
      const shares = JSON.parse(result);
      return Array.isArray(shares) ? shares : [shares];
    } catch (error: any) {
      logger.error('Failed to list SMB shares:', error.message);
      return [];
    }
  }

  /**
   * List existing NFS shares
   */
  async listNfsShares(): Promise<any[]> {
    try {
      const command = `
        Get-NfsShare | Select-Object Name, Path | ConvertTo-Json -Compress
      `;

      const result = await this.executePowerShell(command);
      const shares = JSON.parse(result);
      return Array.isArray(shares) ? shares : [shares];
    } catch (error: any) {
      logger.warn('Failed to list NFS shares (NFS may not be installed):', error.message);
      return [];
    }
  }

  /**
   * Generate PowerShell script for creating shares
   */
  async generateExportScript(config: WindowsExportConfig): Promise<string> {
    const script: string[] = [
      '# Windows File Server Share Configuration Script',
      `# Generated by StorageMover on ${new Date().toISOString()}`,
      '# Run this script on the Windows file server with administrator privileges',
      '',
      '# Ensure script is running as administrator',
      'if (-not ([Security.Principal.WindowsPrincipal][Security.Principal.WindowsIdentity]::GetCurrent()).IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)) {',
      '    Write-Error "This script must be run as Administrator"',
      '    exit 1',
      '}',
      '',
      'Write-Host "Creating directories and shares..." -ForegroundColor Green',
      ''
    ];

    // Create directories
    script.push('# Create directories');
    for (const exp of config.sourceExports) {
      const targetPath = `${config.targetBasePath}${exp.path}`.replace(/\//g, '\\');
      script.push(`New-Item -Path "${targetPath}" -ItemType Directory -Force | Out-Null`);
      script.push(`Write-Host "Created directory: ${targetPath}"`);
    }

    script.push('');
    script.push('# Create SMB shares');

    // Create SMB shares
    for (const exp of config.sourceExports) {
      if (exp.type === 'smb' || exp.type === 'both') {
        const targetPath = `${config.targetBasePath}${exp.path}`.replace(/\//g, '\\');
        const shareName = exp.path.split('/').filter(Boolean).pop() || 'share';
        const description = exp.description || `SMB Share migrated from source`;

        script.push('');
        script.push(`# Share: ${shareName}`);
        script.push(`$shareParams = @{`);
        script.push(`    Name = "${shareName}"`);
        script.push(`    Path = "${targetPath}"`);
        script.push(`    Description = "${description}"`);

        if (config.smbSettings.fullAccess && config.smbSettings.fullAccess.length > 0) {
          script.push(`    FullAccess = @(${config.smbSettings.fullAccess.map(u => `"${u}"`).join(', ')})`);
        } else {
          script.push(`    FullAccess = "Everyone"`);
        }

        if (config.smbSettings.changeAccess && config.smbSettings.changeAccess.length > 0) {
          script.push(`    ChangeAccess = @(${config.smbSettings.changeAccess.map(u => `"${u}"`).join(', ')})`);
        }

        if (config.smbSettings.readAccess && config.smbSettings.readAccess.length > 0) {
          script.push(`    ReadAccess = @(${config.smbSettings.readAccess.map(u => `"${u}"`).join(', ')})`);
        }

        if (config.smbSettings.cachingMode) {
          script.push(`    CachingMode = "${config.smbSettings.cachingMode}"`);
        }

        if (config.smbSettings.encryptData) {
          script.push(`    EncryptData = $true`);
        }

        script.push(`}`);
        script.push(`New-SmbShare @shareParams -ErrorAction Stop`);
        script.push(`Write-Host "Created SMB share: ${shareName}"`);
      }
    }

    // Create NFS shares if needed
    const hasNfsExports = config.sourceExports.some(e => e.type === 'nfs' || e.type === 'both');
    if (hasNfsExports && config.nfsSettings) {
      script.push('');
      script.push('# Create NFS shares');
      script.push('# Note: Requires NFS Server feature installed');
      script.push('# Install with: Install-WindowsFeature -Name FS-NFS-Service');
      script.push('');

      for (const exp of config.sourceExports) {
        if (exp.type === 'nfs' || exp.type === 'both') {
          const targetPath = `${config.targetBasePath}${exp.path}`.replace(/\//g, '\\');

          script.push(`# NFS Export: ${targetPath}`);
          script.push(`$nfsParams = @{`);
          script.push(`    Name = "${targetPath}"`);
          script.push(`    Path = "${targetPath}"`);
          script.push(`    EnableUnmappedAccess = $${config.nfsSettings.enableUnmappedAccess !== false}`);

          if (config.nfsSettings.allowRootAccess !== undefined) {
            script.push(`    AllowRootAccess = $${config.nfsSettings.allowRootAccess}`);
          }

          if (config.nfsSettings.anonymousUid !== undefined) {
            script.push(`    AnonymousUid = ${config.nfsSettings.anonymousUid}`);
          }

          if (config.nfsSettings.anonymousGid !== undefined) {
            script.push(`    AnonymousGid = ${config.nfsSettings.anonymousGid}`);
          }

          script.push(`}`);
          script.push(`New-NfsShare @nfsParams -ErrorAction Stop`);
          script.push(`Grant-NfsSharePermission -Name "${targetPath}" -ClientName "*" -ClientType "host" -Permission "readwrite"`);
          script.push(`Write-Host "Created NFS share: ${targetPath}"`);
          script.push('');
        }
      }
    }

    script.push('');
    script.push('Write-Host "Share configuration completed successfully!" -ForegroundColor Green');

    return script.join('\n');
  }

  /**
   * Apply export configuration directly to Windows server
   */
  async applyExportConfig(config: WindowsExportConfig): Promise<{ success: boolean; results: any[] }> {
    const results: any[] = [];

    // Create directories
    for (const exp of config.sourceExports) {
      const targetPath = `${config.targetBasePath}${exp.path}`.replace(/\//g, '\\');
      try {
        await this.createDirectory(targetPath);
        results.push({ action: 'createDirectory', path: targetPath, success: true });
      } catch (error: any) {
        results.push({
          action: 'createDirectory',
          path: targetPath,
          success: false,
          error: error.message
        });
      }
    }

    // Create SMB shares
    for (const exp of config.sourceExports) {
      if (exp.type === 'smb' || exp.type === 'both') {
        const targetPath = `${config.targetBasePath}${exp.path}`.replace(/\//g, '\\');
        const shareName = exp.path.split('/').filter(Boolean).pop() || 'share';
        const description = exp.description || `SMB Share migrated from source`;

        try {
          await this.createSmbShare(shareName, targetPath, description, config.smbSettings);
          results.push({
            action: 'createSmbShare',
            name: shareName,
            path: targetPath,
            success: true
          });
        } catch (error: any) {
          results.push({
            action: 'createSmbShare',
            name: shareName,
            path: targetPath,
            success: false,
            error: error.message
          });
        }
      }
    }

    // Create NFS shares
    for (const exp of config.sourceExports) {
      if (exp.type === 'nfs' || exp.type === 'both') {
        const targetPath = `${config.targetBasePath}${exp.path}`.replace(/\//g, '\\');

        try {
          await this.createNfsShare(targetPath, config.nfsSettings);
          results.push({
            action: 'createNfsShare',
            path: targetPath,
            success: true
          });
        } catch (error: any) {
          results.push({
            action: 'createNfsShare',
            path: targetPath,
            success: false,
            error: error.message
          });
        }
      }
    }

    const allSuccess = results.every(r => r.success);
    return { success: allSuccess, results };
  }

  /**
   * Mount remote NFS or SMB share on Windows server
   * This enables Windows to act as a storage gateway/proxy
   */
  async mountRemoteShare(config: MountConfig): Promise<{ mountPoint: string; success: boolean }> {
    try {
      let script = '';
      let mountPoint = config.mountPoint;

      if (config.sourceType === 'nfs') {
        // Mount NFS share
        // Auto-assign drive letter if not provided
        if (!mountPoint) {
          mountPoint = await this.getAvailableDriveLetter();
        }

        const persistFlag = config.persistent ? '-Persist' : '';

        script = `
          # Mount NFS share
          $nfsPath = "${config.sourceHostname}:${config.sourcePath}"
          $mountPoint = "${mountPoint}"

          # Check if NFS Client is installed
          $nfsClient = Get-WindowsFeature -Name NFS-Client -ErrorAction SilentlyContinue
          if (!$nfsClient -or !$nfsClient.Installed) {
            Write-Output "ERROR: NFS Client not installed. Install with: Install-WindowsFeature -Name NFS-Client"
            exit 1
          }

          # Unmount if already mounted
          $existing = Get-PSDrive -Name $mountPoint.Replace(':', '') -ErrorAction SilentlyContinue
          if ($existing) {
            Remove-PSDrive -Name $mountPoint.Replace(':', '') -Force -ErrorAction SilentlyContinue
          }

          # Mount the NFS share
          New-PSDrive -Name $mountPoint.Replace(':', '') -PSProvider FileSystem -Root $nfsPath ${persistFlag} -ErrorAction Stop

          Write-Output "SUCCESS: Mounted $nfsPath to $mountPoint"
          Write-Output "MOUNT_POINT:$mountPoint"
        `;
      } else {
        // Mount SMB share
        if (!mountPoint) {
          mountPoint = await this.getAvailableDriveLetter();
        }

        const persistFlag = config.persistent ? '$true' : '$false';

        // Build credential if provided
        let credentialSetup = '';
        if (config.sourceUsername && config.sourcePassword) {
          credentialSetup = `
            $securePassword = ConvertTo-SecureString "${config.sourcePassword}" -AsPlainText -Force
            $credential = New-Object System.Management.Automation.PSCredential("${config.sourceUsername}", $securePassword)
            $credParam = @{ Credential = $credential }
          `;
        } else {
          credentialSetup = '$credParam = @{}';
        }

        script = `
          # Mount SMB share
          $smbPath = "\\\\${config.sourceHostname}${config.sourcePath.replace(/\//g, '\\')}"
          $mountPoint = "${mountPoint}"

          ${credentialSetup}

          # Remove existing mapping if present
          if (Test-Path $mountPoint) {
            net use $mountPoint /delete /y 2>$null
          }

          # Map the network drive
          if ($credParam.Count -gt 0) {
            $cred = $credParam.Credential
            net use $mountPoint $smbPath /user:$($cred.UserName) $($cred.GetNetworkCredential().Password) /persistent:$(if(${persistFlag}) {'yes'} else {'no'})
          } else {
            net use $mountPoint $smbPath /persistent:$(if(${persistFlag}) {'yes'} else {'no'})
          }

          if ($LASTEXITCODE -ne 0) {
            throw "Failed to mount SMB share"
          }

          Write-Output "SUCCESS: Mounted $smbPath to $mountPoint"
          Write-Output "MOUNT_POINT:$mountPoint"
        `;
      }

      const result = await this.executePowerShell(script);

      if (result.includes('ERROR:')) {
        throw new Error(result);
      }

      // Extract mount point from result
      const match = result.match(/MOUNT_POINT:(.+)/);
      const actualMountPoint = match ? match[1].trim() : mountPoint || '';

      logger.info(`Successfully mounted ${config.sourceHostname}:${config.sourcePath} to ${actualMountPoint}`);

      return {
        mountPoint: actualMountPoint,
        success: true
      };

    } catch (error: any) {
      logger.error(`Failed to mount remote share: ${error.message}`);
      throw error;
    }
  }

  /**
   * Get next available drive letter for mounting
   */
  private async getAvailableDriveLetter(): Promise<string> {
    const script = `
      # Get all used drive letters
      $usedDrives = Get-PSDrive -PSProvider FileSystem | Select-Object -ExpandProperty Name

      # Find first available letter from Z to A (reverse to avoid conflicts)
      $letters = [char[]]([char]'Z'..[char]'A')
      foreach ($letter in $letters) {
        $drive = "$letter:"
        if ($usedDrives -notcontains $letter) {
          Write-Output $drive
          break
        }
      }
    `;

    try {
      const result = await this.executePowerShell(script);
      return result.trim() || 'Z:';
    } catch (error) {
      // Fallback to Z: if detection fails
      return 'Z:';
    }
  }

  /**
   * Unmount a remote share
   */
  async unmountRemoteShare(mountPoint: string, type: 'nfs' | 'smb'): Promise<boolean> {
    try {
      const script = `
        # Unmount the share
        if (Test-Path "${mountPoint}") {
          net use ${mountPoint} /delete /y
          if ($LASTEXITCODE -eq 0) {
            Write-Output "Successfully unmounted ${mountPoint}"
          } else {
            # Try PowerShell method
            Remove-PSDrive -Name "${mountPoint.replace(':', '')}" -Force -ErrorAction Stop
            Write-Output "Successfully unmounted ${mountPoint}"
          }
        } else {
          Write-Output "Mount point ${mountPoint} not found"
        }
      `;

      await this.executePowerShell(script);
      logger.info(`Successfully unmounted ${mountPoint}`);
      return true;

    } catch (error: any) {
      logger.error(`Failed to unmount ${mountPoint}: ${error.message}`);
      return false;
    }
  }

  /**
   * List all current mounts (NFS and SMB)
   */
  async listMounts(): Promise<{ mounts: any[] }> {
    try {
      const script = `
        # Get all network drives
        $drives = Get-PSDrive -PSProvider FileSystem | Where-Object { $_.DisplayRoot -like '*\\\\*' -or $_.DisplayRoot -like '*:*' }
        $drives | Select-Object Name, @{Name='LocalPath';Expression={$_.Name+':'}}, @{Name='RemotePath';Expression={$_.DisplayRoot}} | ConvertTo-Json -Compress
      `;

      const result = await this.executePowerShell(script);

      try {
        const parsed = JSON.parse(result);
        const mounts = Array.isArray(parsed) ? parsed : (parsed ? [parsed] : []);
        return { mounts };
      } catch {
        return { mounts: [] };
      }

    } catch (error: any) {
      logger.warn(`Failed to list mounts: ${error.message}`);
      return { mounts: [] };
    }
  }

  /**
   * Create a proxy share - SMB/NFS share that points to a mounted path
   * This enables Windows to re-export remote shares
   */
  async createProxyShare(
    shareName: string,
    mountedPath: string,
    exportType: 'nfs' | 'smb' | 'both',
    description: string = '',
    options: WindowsExportConfig['smbSettings'] = {}
  ): Promise<{ success: boolean; results: any[] }> {
    const results: any[] = [];

    // Create SMB share pointing to mounted path
    if (exportType === 'smb' || exportType === 'both') {
      try {
        await this.createSmbShare(shareName, mountedPath, description, options);
        results.push({
          action: 'createSmbProxyShare',
          name: shareName,
          path: mountedPath,
          success: true
        });
      } catch (error: any) {
        results.push({
          action: 'createSmbProxyShare',
          name: shareName,
          path: mountedPath,
          success: false,
          error: error.message
        });
      }
    }

    // Create NFS export pointing to mounted path
    if (exportType === 'nfs' || exportType === 'both') {
      try {
        await this.createNfsShare(mountedPath);
        results.push({
          action: 'createNfsProxyShare',
          path: mountedPath,
          success: true
        });
      } catch (error: any) {
        results.push({
          action: 'createNfsProxyShare',
          path: mountedPath,
          success: false,
          error: error.message
        });
      }
    }

    const allSuccess = results.every(r => r.success);
    return { success: allSuccess, results };
  }

  /**
   * Clone a mount from any source (Linux NFS, Linux Samba, Windows SMB, PowerScale, Isilon)
   * to this Windows gateway server. This mounts the source and re-exports it as a Windows share.
   */
  async cloneMount(config: MountCloneConfig): Promise<MountCloneResult> {
    const logs: MountCloneLog[] = [];
    const addLog = (level: MountCloneLog['level'], message: string, details?: string) => {
      logs.push({ level, message, details, timestamp: new Date() });
      if (level === 'error') {
        logger.error(`[MountClone] ${message}`, details);
      } else if (level === 'warn') {
        logger.warn(`[MountClone] ${message}`, details);
      } else {
        logger.info(`[MountClone] ${message}`);
      }
    };

    try {
      addLog('info', `Starting mount clone: ${config.name}`);
      addLog('info', `Source: ${config.sourceType} - ${config.sourceHostname}:${config.sourcePath}`);

      // Determine mount type based on source type
      let mountType: 'nfs' | 'smb';
      switch (config.sourceType) {
        case 'linux_nfs':
        case 'powerscale_nfs':
        case 'isilon_nfs':
          mountType = 'nfs';
          break;
        case 'linux_smb':
        case 'windows_smb':
        case 'powerscale_smb':
        case 'isilon_smb':
          mountType = 'smb';
          break;
        default:
          throw new Error(`Unknown source type: ${config.sourceType}`);
      }

      addLog('info', `Mount type determined: ${mountType.toUpperCase()}`);

      // Step 1: Mount the remote share
      const mountConfig: MountConfig = {
        sourceHostname: config.sourceHostname,
        sourcePath: config.sourcePath,
        sourceType: mountType,
        sourceUsername: config.sourceUsername,
        sourcePassword: config.sourcePassword,
        persistent: config.persistent !== false
      };

      addLog('info', `Mounting remote ${mountType.toUpperCase()} share...`);
      const mountResult = await this.mountRemoteShare(mountConfig);

      if (!mountResult.success) {
        addLog('error', 'Failed to mount remote share', 'Mount operation returned failure');
        return { success: false, error: 'Failed to mount remote share', logs };
      }

      addLog('info', `Successfully mounted to ${mountResult.mountPoint}`);

      // Step 2: Create proxy shares to re-export the mount
      const shareName = config.shareName || this.generateShareName(config.sourcePath);
      const shareType = config.shareType || 'smb';
      const description = `Gateway clone: ${config.sourceHostname}:${config.sourcePath}`;

      addLog('info', `Creating proxy share: ${shareName} (${shareType})`);

      const proxyResult = await this.createProxyShare(
        shareName,
        mountResult.mountPoint,
        shareType,
        description,
        config.smbSettings || { fullAccess: ['Everyone'] }
      );

      if (!proxyResult.success) {
        addLog('warn', 'Some proxy shares failed to create', JSON.stringify(proxyResult.results));
      } else {
        addLog('info', `Proxy share created successfully`);
      }

      // Log detailed results
      for (const result of proxyResult.results) {
        if (result.success) {
          addLog('info', `${result.action} completed`, JSON.stringify(result));
        } else {
          addLog('error', `${result.action} failed`, result.error);
        }
      }

      addLog('info', `Mount clone completed: ${shareName}`);

      return {
        success: true,
        mountPoint: mountResult.mountPoint,
        shareName,
        shareType,
        logs
      };

    } catch (error: any) {
      addLog('error', `Mount clone failed: ${error.message}`, error.stack);
      return {
        success: false,
        error: error.message,
        logs
      };
    }
  }

  /**
   * Clone multiple mounts in batch
   */
  async cloneMountsBatch(configs: MountCloneConfig[]): Promise<{ results: MountCloneResult[]; summary: { total: number; succeeded: number; failed: number } }> {
    const results: MountCloneResult[] = [];
    let succeeded = 0;
    let failed = 0;

    for (const config of configs) {
      const result = await this.cloneMount(config);
      results.push(result);
      if (result.success) {
        succeeded++;
      } else {
        failed++;
      }
    }

    return {
      results,
      summary: {
        total: configs.length,
        succeeded,
        failed
      }
    };
  }

  /**
   * Check health status of a cloned mount
   */
  async checkMountHealth(mountPoint: string, shareName: string): Promise<MountHealthStatus> {
    try {
      const script = `
        $result = @{
          accessible = $false
          mountPoint = "${mountPoint}"
          remotePath = ""
          shareActive = $false
          error = $null
        }

        # Check if mount point is accessible
        try {
          if (Test-Path "${mountPoint}") {
            $result.accessible = $true

            # Get remote path for network drive
            $drive = Get-PSDrive -Name "${mountPoint.replace(':', '')}" -ErrorAction SilentlyContinue
            if ($drive -and $drive.DisplayRoot) {
              $result.remotePath = $drive.DisplayRoot
            }
          }
        } catch {
          $result.error = $_.Exception.Message
        }

        # Check if share is active
        try {
          $share = Get-SmbShare -Name "${shareName}" -ErrorAction SilentlyContinue
          if ($share) {
            $result.shareActive = $true
          }
        } catch {
          # Share might not exist or NFS share
        }

        $result | ConvertTo-Json -Compress
      `;

      const output = await this.executePowerShell(script);
      const status = JSON.parse(output);

      return {
        accessible: status.accessible,
        mountPoint: status.mountPoint,
        remotePath: status.remotePath || '',
        shareActive: status.shareActive,
        lastChecked: new Date(),
        error: status.error || undefined
      };

    } catch (error: any) {
      return {
        accessible: false,
        mountPoint,
        remotePath: '',
        shareActive: false,
        lastChecked: new Date(),
        error: error.message
      };
    }
  }

  /**
   * Remove a cloned mount (unmount and remove shares)
   */
  async removeClonedMount(mountPoint: string, shareName: string, shareType: 'nfs' | 'smb' | 'both'): Promise<{ success: boolean; logs: MountCloneLog[] }> {
    const logs: MountCloneLog[] = [];
    const addLog = (level: MountCloneLog['level'], message: string, details?: string) => {
      logs.push({ level, message, details, timestamp: new Date() });
      logger[level === 'debug' ? 'info' : level](`[MountClone] ${message}`);
    };

    try {
      addLog('info', `Removing cloned mount: ${mountPoint}, share: ${shareName}`);

      // Step 1: Remove SMB share
      if (shareType === 'smb' || shareType === 'both') {
        try {
          const removeSmb = `
            $share = Get-SmbShare -Name "${shareName}" -ErrorAction SilentlyContinue
            if ($share) {
              Remove-SmbShare -Name "${shareName}" -Force -ErrorAction Stop
              Write-Output "SMB share removed"
            } else {
              Write-Output "SMB share not found"
            }
          `;
          await this.executePowerShell(removeSmb);
          addLog('info', `SMB share ${shareName} removed`);
        } catch (error: any) {
          addLog('warn', `Failed to remove SMB share: ${error.message}`);
        }
      }

      // Step 2: Remove NFS share
      if (shareType === 'nfs' || shareType === 'both') {
        try {
          const removeNfs = `
            $share = Get-NfsShare -Path "${mountPoint}" -ErrorAction SilentlyContinue
            if ($share) {
              Remove-NfsShare -Path "${mountPoint}" -Force -ErrorAction Stop
              Write-Output "NFS share removed"
            } else {
              Write-Output "NFS share not found"
            }
          `;
          await this.executePowerShell(removeNfs);
          addLog('info', `NFS share for ${mountPoint} removed`);
        } catch (error: any) {
          addLog('warn', `Failed to remove NFS share: ${error.message}`);
        }
      }

      // Step 3: Unmount the drive
      try {
        await this.unmountRemoteShare(mountPoint, 'smb');
        addLog('info', `Mount point ${mountPoint} unmounted`);
      } catch (error: any) {
        addLog('warn', `Failed to unmount: ${error.message}`);
      }

      addLog('info', 'Cloned mount removal completed');
      return { success: true, logs };

    } catch (error: any) {
      addLog('error', `Failed to remove cloned mount: ${error.message}`);
      return { success: false, logs };
    }
  }

  /**
   * List all cloned mounts (network drives with re-exported shares)
   */
  async listClonedMounts(): Promise<{ mounts: any[] }> {
    try {
      const script = `
        $clonedMounts = @()

        # Get all network drives
        $networkDrives = Get-PSDrive -PSProvider FileSystem | Where-Object { $_.DisplayRoot -like '*\\\\*' -or $_.DisplayRoot -like '*:*' }

        foreach ($drive in $networkDrives) {
          $driveLetter = $drive.Name + ":"

          # Find shares pointing to this drive
          $relatedShares = Get-SmbShare | Where-Object { $_.Path -like "$driveLetter*" } | Select-Object Name, Path

          $mount = @{
            mountPoint = $driveLetter
            remotePath = $drive.DisplayRoot
            shares = @($relatedShares)
          }

          $clonedMounts += $mount
        }

        $clonedMounts | ConvertTo-Json -Depth 3 -Compress
      `;

      const output = await this.executePowerShell(script);

      try {
        const parsed = JSON.parse(output);
        const mounts = Array.isArray(parsed) ? parsed : (parsed ? [parsed] : []);
        return { mounts };
      } catch {
        return { mounts: [] };
      }

    } catch (error: any) {
      logger.warn(`Failed to list cloned mounts: ${error.message}`);
      return { mounts: [] };
    }
  }

  /**
   * Generate a safe share name from a path
   */
  private generateShareName(sourcePath: string): string {
    // Extract the last component of the path and sanitize it
    const pathParts = sourcePath.replace(/\\/g, '/').split('/').filter(Boolean);
    const baseName = pathParts[pathParts.length - 1] || 'share';

    // Replace invalid characters and limit length
    return baseName
      .replace(/[^a-zA-Z0-9_-]/g, '_')
      .substring(0, 80);
  }

  /**
   * Discover mountable shares from a remote host
   * Useful for finding what can be cloned from Linux/Windows servers
   */
  async discoverRemoteShares(
    hostname: string,
    type: 'nfs' | 'smb',
    username?: string,
    password?: string
  ): Promise<{ shares: Array<{ path: string; type: string; description?: string }> }> {
    try {
      let script = '';

      if (type === 'smb') {
        // Discover SMB shares
        if (username && password) {
          script = `
            $securePassword = ConvertTo-SecureString "${password}" -AsPlainText -Force
            $credential = New-Object System.Management.Automation.PSCredential("${username}", $securePassword)

            try {
              $shares = net view \\\\${hostname} 2>&1
              if ($LASTEXITCODE -eq 0) {
                $shareList = @()
                $shares | ForEach-Object {
                  if ($_ -match '^(\\S+)\\s+Disk') {
                    $shareList += @{
                      path = "\\\\${hostname}\\" + $Matches[1]
                      type = "smb"
                      description = "SMB Share"
                    }
                  }
                }
                $shareList | ConvertTo-Json -Compress
              } else {
                "[]"
              }
            } catch {
              "[]"
            }
          `;
        } else {
          script = `
            try {
              $shares = net view \\\\${hostname} 2>&1
              if ($LASTEXITCODE -eq 0) {
                $shareList = @()
                $shares | ForEach-Object {
                  if ($_ -match '^(\\S+)\\s+Disk') {
                    $shareList += @{
                      path = "\\\\${hostname}\\" + $Matches[1]
                      type = "smb"
                      description = "SMB Share"
                    }
                  }
                }
                $shareList | ConvertTo-Json -Compress
              } else {
                "[]"
              }
            } catch {
              "[]"
            }
          `;
        }
      } else {
        // Discover NFS exports using showmount
        script = `
          try {
            $exports = showmount -e ${hostname} 2>&1
            if ($LASTEXITCODE -eq 0) {
              $exportList = @()
              $exports | ForEach-Object {
                if ($_ -match '^(/\\S+)') {
                  $exportList += @{
                    path = $Matches[1]
                    type = "nfs"
                    description = "NFS Export"
                  }
                }
              }
              $exportList | ConvertTo-Json -Compress
            } else {
              "[]"
            }
          } catch {
            "[]"
          }
        `;
      }

      const output = await this.executePowerShell(script);

      try {
        const parsed = JSON.parse(output);
        const shares = Array.isArray(parsed) ? parsed : (parsed ? [parsed] : []);
        return { shares };
      } catch {
        return { shares: [] };
      }

    } catch (error: any) {
      logger.warn(`Failed to discover remote shares: ${error.message}`);
      return { shares: [] };
    }
  }
}
