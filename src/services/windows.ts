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
}
