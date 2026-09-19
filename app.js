const express = require('express');
const http = require('http');
const WebSocket = require('ws');
const sqlite3 = require('sqlite3').verbose();
const bcrypt = require('bcryptjs');
const session = require('express-session');
const path = require('path');
const fs = require('fs');
const net = require('net');
const { spawn, exec, execSync } = require('child_process');
const os = require('os');
const util = require('util');
const execPromise = util.promisify(exec);
const { Client } = require('ssh2');
require('dotenv').config();
const licenses = require("./licenses");

// ============= PLATFORM DETECTION =============
const isWindows = process.platform === 'win32';
const isLinux = process.platform === 'linux';

// ============= CONSTANTS =============
const DEFAULT_SSH_PORT = 2222;
const DEFAULT_HTTP_PORT = 80;

// ============= UTILITY FUNCTIONS =============

/**
 * Get validated SSH port from VM
 * Consolidates ssh_port and ssh_port_static into single value
 */
function getSSHPort(vm) {
  const port = vm.ssh_port || vm.ssh_port_static || DEFAULT_SSH_PORT;
  const portNum = parseInt(port);
  if (isNaN(portNum) || portNum < 1 || portNum > 65535) {
    return DEFAULT_SSH_PORT;
  }
  return portNum;
}

/**
 * Get validated HTTP port from VM
 */
function getHTTPPort(vm) {
  if (!vm.http_port) return DEFAULT_HTTP_PORT;
  const portNum = parseInt(vm.http_port);
  if (isNaN(portNum) || portNum < 1 || portNum > 65535) {
    return DEFAULT_HTTP_PORT;
  }
  return portNum;
}

/**
 * Log errors with VM context
 */
function logError(component, vm_id, action, error) {
  console.error(`[${component}-${vm_id}] ${action} FAILED: ${error.message}`);
  if (error.stack) {
    console.error(`[${component}-${vm_id}] Stack: ${error.stack}`);
  }
}

const app = express();
const server = http.createServer(app);
const wss = new WebSocket.Server({ server });
const PORT = process.env.PORT || 8080;

// For binary: use home directory or custom location for database
// __dirname will be /snapshot/hkvm (read-only in binary), so use home directory
const dbDir = process.env.HKVM_DATA_DIR || path.join(os.homedir(), '.hkvm');
const dbPath = path.join(dbDir, 'hkvm.db');

// Ensure database directory exists and is writable
try {
  if (!fs.existsSync(dbDir)) {
    fs.mkdirSync(dbDir, { recursive: true, mode: 0o755 });
    console.log('[Init] Created database directory:', dbDir);
  }
} catch (error) {
  console.error('[Init] Failed to create database directory:', dbDir, error.message);
  process.exit(1);
}

const db = new sqlite3.Database(dbPath);

const VM_DIR = path.join(os.homedir(), 'vms');
const TEMPLATES_DIR = path.join(VM_DIR, 'templates');
const ISO_DIR = path.join(VM_DIR, 'iso');
const CLOUDVM_DIR = path.join(VM_DIR, 'cloudvm');

// Create directories if they don't exist
if (!fs.existsSync(VM_DIR)) {
  fs.mkdirSync(VM_DIR, { recursive: true });
}
if (!fs.existsSync(TEMPLATES_DIR)) {
  fs.mkdirSync(TEMPLATES_DIR, { recursive: true });
}
if (!fs.existsSync(ISO_DIR)) {
  fs.mkdirSync(ISO_DIR, { recursive: true });
}
if (!fs.existsSync(CLOUDVM_DIR)) {
  fs.mkdirSync(CLOUDVM_DIR, { recursive: true });
}

// CPU Models available
const CPU_MODELS = {
  'host': {
    name: 'Host CPU (Native)',
    description: 'Use host CPU directly - best performance',
    features: 'host'
  },
  'max': {
    name: 'Maximum Features',
    description: 'Maximum supported features by QEMU',
    features: 'max'
  },
  'qemu64': {
    name: 'QEMU 64-bit',
    description: 'Generic 64-bit processor',
    features: 'qemu64'
  },
  'kvm64': {
    name: 'KVM 64-bit',
    description: 'Optimized for KVM',
    features: 'kvm64'
  },
  'core2duo': {
    name: 'Core 2 Duo',
    description: 'Intel Core 2 Duo',
    features: 'core2duo'
  },
  'corei7': {
    name: 'Core i7',
    description: 'Intel Core i7',
    features: 'corei7'
  },
  'skylake': {
    name: 'Skylake',
    description: 'Intel Skylake',
    features: 'Skylake-Client'
  },
  'cascadelake': {
    name: 'Cascade Lake',
    description: 'Intel Cascade Lake (Server)',
    features: 'Cascadelake-Server'
  },
  'opteron': {
    name: 'Opteron',
    description: 'AMD Opteron',
    features: 'opteron'
  },
  'epyc': {
    name: 'EPYC',
    description: 'AMD EPYC (Server)',
    features: 'EPYC'
  }
};

// Machine Types available for QEMU
const MACHINE_TYPES = {
  'pc': {
    name: 'PC (i440fx - Standard)',
    description: 'Legacy PC emulation, compatible with old guests',
    arch: 'x86_64',
    features: 'Legacy BIOS, VGA, ISA/PCI buses'
  },
  'q35': {
    name: 'Q35 (ICH9 - Modern)',
    description: 'Modern chipset, recommended for newer OS',
    arch: 'x86_64',
    features: 'UEFI-ready, PCIe support, higher performance'
  },
  'microvm': {
    name: 'MicroVM (Minimal)',
    description: 'Lightweight machine type with minimal overhead',
    arch: 'x86_64',
    features: 'Fast boot, low memory footprint, optimal for containers'
  },
  'virt': {
    name: 'Virtual (ARM Generic)',
    description: 'Generic virtual platform for ARM64',
    arch: 'aarch64',
    features: 'ARM64 architecture, flexible device model'
  },
  'versatilepb': {
    name: 'Versatile Platform Baseboard (ARM)',
    description: 'ARM reference board platform',
    arch: 'arm',
    features: 'ARM 32-bit, integrator-style board'
  },
  'raspi2': {
    name: 'Raspberry Pi 2 (ARM)',
    description: 'Emulate Raspberry Pi 2 hardware',
    arch: 'arm',
    features: 'ARM-based SBC, GPIO and peripherals'
  },
  'raspi3': {
    name: 'Raspberry Pi 3 (ARM)',
    description: 'Emulate Raspberry Pi 3 hardware',
    arch: 'arm',
    features: 'ARM 64-bit, WiFi/Bluetooth simulation'
  },
  'pseries': {
    name: 'POWER Series (PowerPC)',
    description: 'IBM Power Systems emulation',
    arch: 'ppc64',
    features: 'PowerPC 64-bit, server-class machine'
  },
  's390-ccw-virtio': {
    name: 'IBM System Z (s390x)',
    description: 'IBM mainframe architecture',
    arch: 's390x',
    features: 's390x architecture, enterprise computing'
  }
};

// Network Configuration Types
const NETWORK_TYPES = {
  dhcp: {
    name: 'DHCP (Automatic)',
    description: 'Auto IP from DHCP server',
    icon: '<svg viewBox="0 0 24 24" width="48" height="48" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" style="color: #3B82F6;"><circle cx="12" cy="12" r="10"/><path d="M8 12a4 4 0 0 0 8 0M12 2v4M12 18v4M2 12h4M18 12h4"/></svg>'
  },
  static_public: {
    name: 'Static Public IPv4',
    description: 'Fixed public IP address',
    icon: '<svg viewBox="0 0 24 24" width="48" height="48" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" style="color: #10B981;"><path d="M21 16V8a2 2 0 0 0-1-1.73l-7-4a2 2 0 0 0-2 0l-7 4A2 2 0 0 0 3 8v8a2 2 0 0 0 1 1.73l7 4a2 2 0 0 0 2 0l7-4A2 2 0 0 0 21 16z"/><polyline points="3.27 6.96 12 12.88 20.73 6.96M12 22.08v-9.53"/></svg>'
  },
  static_private: {
    name: 'Static Private IPv4',
    description: 'Fixed private IP (192.168.x.x, 10.x.x.x)',
    icon: '<svg viewBox="0 0 24 24" width="48" height="48" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" style="color: #F59E0B;"><rect x="3" y="3" width="18" height="18" rx="2"/><path d="M9 11a3 3 0 1 1 6 0a3 3 0 0 1-6 0M12 7v3m0 7v3"/></svg>'
  },
  dual_stack: {
    name: 'Dual Stack (IPv4 + IPv6)',
    description: 'IPv4 and IPv6 support',
    icon: '<svg viewBox="0 0 24 24" width="48" height="48" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" style="color: #EC4899;"><path d="M13 2L3 14h9l-1 8 10-12h-9l1-8z"/></svg>'
  }
};

// DNS Providers
const DNS_PROVIDERS = [
  { name: 'Google DNS', primary: '8.8.8.8', secondary: '8.8.4.4' },
  { name: 'Cloudflare DNS', primary: '1.1.1.1', secondary: '1.0.0.1' },
  { name: 'Quad9 DNS', primary: '9.9.9.9', secondary: '149.112.112.112' },
  { name: 'OpenDNS', primary: '208.67.222.222', secondary: '208.67.220.220' },
  { name: 'Custom', primary: '', secondary: '' }
];

// SMBIOS Manufacturers
const SMBIOS_MANUFACTURERS = [
  'QEMU',
  'Proxmox',
  'Red Hat',
  'VirtualBox',
  'Microsoft Corporation',
  'Dell Inc.',
  'HP Inc.',
  'Lenovo',
  'Custom'
];

// SMBIOS Products
const SMBIOS_PRODUCTS = [
  'KVM Virtual Machine',
  'Standard PC',
  'RHEL Guest',
  'VirtualBox',
  'Virtual Machine',
  'Custom VM',
  'Cloud Instance'
];
const OS_TEMPLATES = {
  ubuntu_22_cloud: {
    name: 'Ubuntu 22.04 LTS',
    type: 'cloud-init',
    icon: 'https://i.imgur.com/wu0Ob6B.png',
    disk_size: '20G',
    memory: 2048,
    cpus: 2,
    url: 'https://cloud-images.ubuntu.com/jammy/current/jammy-server-cloudimg-amd64.img',
    username: 'ubuntu',
    password: 'ubuntu'
  },
  ubuntu_24_cloud: {
    name: 'Ubuntu 24.04 LTS',
    type: 'cloud-init',
    icon: 'https://i.imgur.com/wu0Ob6B.png',
    disk_size: '20G',
    memory: 2048,
    cpus: 2,
    url: 'https://cloud-images.ubuntu.com/noble/current/noble-server-cloudimg-amd64.img',
    username: 'ubuntu',
    password: 'ubuntu'
  },
  debian_12_cloud: {
    name: 'Debian 12',
    type: 'cloud-init',
    icon: 'https://i.imgur.com/C4SiENP.png',
    disk_size: '20G',
    memory: 2048,
    cpus: 2,
    url: 'https://cloud.debian.org/images/cloud/bookworm/latest/debian-12-generic-amd64.qcow2',
    username: 'debian',
    password: 'debian'
  },
  fedora_40_cloud: {
    name: 'Fedora 40',
    type: 'cloud-init',
    icon: 'https://i.imgur.com/iq4y3J8.png',
    disk_size: '20G',
    memory: 2048,
    cpus: 2,
    url: 'https://download.fedoraproject.org/pub/fedora/linux/releases/40/Cloud/x86_64/images/Fedora-Cloud-Base-40-1.14.x86_64.qcow2',
    username: 'fedora',
    password: 'fedora'
  },
  centos_9_cloud: {
    name: 'CentOS Stream 9',
    type: 'cloud-init',
    icon: 'https://i.imgur.com/MgxK5WZ.png',
    disk_size: '20G',
    memory: 2048,
    cpus: 2,
    url: 'https://cloud.centos.org/centos/9-stream/x86_64/images/CentOS-Stream-GenericCloud-9-latest.x86_64.qcow2',
    username: 'centos',
    password: 'centos'
  },
  almalinux_9_cloud: {
    name: 'AlmaLinux 9',
    type: 'cloud-init',
    icon: 'https://i.imgur.com/YcYGa2c.png',
    disk_size: '20G',
    memory: 2048,
    cpus: 2,
    url: 'https://repo.almalinux.org/almalinux/9/cloud/x86_64/images/AlmaLinux-9-GenericCloud-latest.x86_64.qcow2',
    username: 'almalinux',
    password: 'almalinux'
  }
};

// Middleware
app.use(express.json());
app.use(express.urlencoded({ extended: true }));
app.use(express.static(path.join(__dirname, 'public')));
app.use(session({
  secret: 'hopingboyz-secret-key-change-in-production',
  resave: false,
  saveUninitialized: true,
  cookie: { secure: false, maxAge: 24 * 60 * 60 * 1000 }
}));

// Initialize License Middleware
licenses.initLicenseMiddleware(app);

// Set EJS as view engine
app.set('view engine', 'ejs');
app.set('views', path.join(__dirname, 'views'));

// VM Process Manager (Global)
const vmProcesses = new Map();

// Initialize Database
function initializeDatabase() {
  // Enable WAL mode to reduce locking issues
  db.run('PRAGMA journal_mode = WAL', (err) => {
    if (err) console.log('[DB] Could not enable WAL mode:', err.message);
  });
  
  db.run('PRAGMA busy_timeout = 5000', (err) => {
    if (err) console.log('[DB] Could not set busy timeout:', err.message);
  });
  
  db.serialize(() => {
    db.run(`CREATE TABLE IF NOT EXISTS users (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      username TEXT UNIQUE NOT NULL,
      password TEXT NOT NULL,
      email TEXT,
      full_name TEXT,
      role TEXT DEFAULT 'user',
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      last_login DATETIME,
      is_active BOOLEAN DEFAULT 1
    )`);

    // Add missing columns if they don't exist
    db.all(`PRAGMA table_info(users)`, (err, columns) => {
      const columnNames = columns.map(c => c.name);
      if (!columnNames.includes('full_name')) {
        db.run(`ALTER TABLE users ADD COLUMN full_name TEXT`, (err) => {
          if (err) console.log('[DB] full_name column already exists or error:', err.message);
        });
      }
      if (!columnNames.includes('last_login')) {
        db.run(`ALTER TABLE users ADD COLUMN last_login DATETIME`, (err) => {
          if (err) console.log('[DB] last_login column already exists or error:', err.message);
        });
      }
    });

    db.run(`CREATE TABLE IF NOT EXISTS vms (
      vm_id INTEGER PRIMARY KEY AUTOINCREMENT,
      vm_name TEXT UNIQUE NOT NULL,
      os_type TEXT,
      template_type TEXT,
      hostname TEXT,
      username TEXT,
      password TEXT,
      memory INTEGER,
      cpus INTEGER,
      cpu_sockets INTEGER DEFAULT 1,
      cpu_cores INTEGER DEFAULT 2,
      cpu_threads INTEGER DEFAULT 1,
      cpu_model TEXT DEFAULT 'host',
      custom_cpu_name TEXT,
      machine_type TEXT DEFAULT 'pc',
      board_name TEXT DEFAULT 'Main-Board',
      product_name TEXT DEFAULT 'Virtual Machine',
      custom_smbios_manufacturer TEXT DEFAULT 'QEMU',
      disk_size TEXT,
      img_file TEXT,
      seed_file TEXT,
      disk_file TEXT,
      status TEXT DEFAULT 'stopped',
      uptime INTEGER DEFAULT 0,
      node_name TEXT DEFAULT 'localhost',
      smbios_manufacturer TEXT DEFAULT 'QEMU',
      smbios_product TEXT DEFAULT 'KVM Virtual Machine',
      smbios_version TEXT DEFAULT '1.0',
      smbios_serial TEXT,
      extra_args TEXT,
      enable_acpi BOOLEAN DEFAULT 1,
      enable_kvm BOOLEAN DEFAULT 1,
      network_type TEXT DEFAULT 'dhcp',
      ipv4_address TEXT,
      gateway TEXT,
      ipv4_gateway TEXT,
      netmask TEXT DEFAULT '24',
      ipv4_netmask TEXT DEFAULT '255.255.255.0',
      dns_servers TEXT DEFAULT '8.8.8.8,8.8.4.4',
      ssh_port INTEGER,
      ssh_port_static INTEGER DEFAULT 22,
      http_port INTEGER DEFAULT 80,
      ipv6_address TEXT,
      ipv6_gateway TEXT,
      mac_address TEXT,
      bridge_interface TEXT,
      vlan_id INTEGER,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      owner_id INTEGER,
      FOREIGN KEY(owner_id) REFERENCES users(id)
    )`);

    // Add missing columns for existing databases (safe - ignores if already exist)
    const missingColumns = [
      { name: 'custom_cpu_name', def: 'TEXT' },
      { name: 'machine_type', def: "TEXT DEFAULT 'pc'" },
      { name: 'board_name', def: "TEXT DEFAULT 'Main-Board'" },
      { name: 'product_name', def: "TEXT DEFAULT 'Virtual Machine'" },
      { name: 'custom_smbios_manufacturer', def: "TEXT DEFAULT 'QEMU'" },
      { name: 'ipv4_netmask', def: "TEXT DEFAULT '255.255.255.0'" },
      { name: 'dns_primary', def: "TEXT DEFAULT '8.8.8.8'" },
      { name: 'dns_secondary', def: "TEXT DEFAULT '8.8.4.4'" },
      { name: 'iso_attached', def: 'TEXT' },
      { name: 'boot_from_iso', def: 'BOOLEAN DEFAULT 0' }
    ];

    missingColumns.forEach(col => {
      db.run(`ALTER TABLE vms ADD COLUMN ${col.name} ${col.def}`, (err) => {
        if (err) {
          if (!err.message.includes('duplicate column')) {
            console.log(`Note: Column ${col.name} - ${err.message}`);
          }
        } else {
          console.log(`✓ Added column: ${col.name}`);
        }
      });
    });

    db.run(`CREATE TABLE IF NOT EXISTS vm_logs (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      vm_id INTEGER,
      action TEXT,
      status TEXT,
      message TEXT,
      timestamp DATETIME DEFAULT CURRENT_TIMESTAMP,
      FOREIGN KEY(vm_id) REFERENCES vms(vm_id)
    )`);

    db.run(`CREATE TABLE IF NOT EXISTS vm_snapshots (
      snapshot_id INTEGER PRIMARY KEY AUTOINCREMENT,
      vm_id INTEGER,
      snapshot_name TEXT,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      size_gb REAL,
      description TEXT,
      FOREIGN KEY(vm_id) REFERENCES vms(vm_id)
    )`);

    db.run(`CREATE TABLE IF NOT EXISTS os_templates (
      template_id INTEGER PRIMARY KEY AUTOINCREMENT,
      template_key TEXT UNIQUE NOT NULL,
      template_name TEXT NOT NULL,
      template_type TEXT DEFAULT 'cloud-init',
      icon TEXT,
      description TEXT,
      disk_size TEXT DEFAULT '20G',
      memory INTEGER DEFAULT 2048,
      cpus INTEGER DEFAULT 2,
      download_url TEXT,
      local_path TEXT,
      username TEXT,
      password TEXT,
      is_custom BOOLEAN DEFAULT 0,
      is_active BOOLEAN DEFAULT 1,
      created_by INTEGER,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      updated_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      FOREIGN KEY(created_by) REFERENCES users(id)
    )`);

    db.run(`CREATE TABLE IF NOT EXISTS settings (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      setting_key TEXT UNIQUE NOT NULL,
      setting_value TEXT,
      updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
    )`);

    // Initialize default site settings if not exist
    const defaultSettings = {
      'site_name': 'HKVM Panel',
      'site_description': 'Virtual Machine Management System',
      'site_icon_url': 'https://i.imgur.com/0DmkSi4.png',
    };
    
    Object.entries(defaultSettings).forEach(([key, value]) => {
      db.get(`SELECT * FROM settings WHERE setting_key = ?`, [key], (err, row) => {
        if (!row) {
          db.run(`INSERT INTO settings (setting_key, setting_value) VALUES (?, ?)`, [key, value]);
        }
      });
    });

    db.get(`SELECT * FROM users WHERE username = 'admin'`, (err, row) => {
      if (!row) {
        const hashedPassword = bcrypt.hashSync('admin', 10);
        db.run(`INSERT INTO users (username, password, email, role) VALUES (?, ?, ?, ?)`,
          ['admin', hashedPassword, 'admin@hopingboyz.local', 'admin']);
        console.log('✓ Default admin created: admin/admin (role: admin)');
      } else {
        console.log(`✓ Admin user exists: ${row.username} (role: ${row.role})`);
      }
    });
  });
}

// AUTH
function checkAuth(req, res, next) {
  if (!req.session.userId) {
    console.warn(`[Auth Error] Unauthenticated access attempt to ${req.method} ${req.path}`);
    // Always redirect to login, never return JSON error
    return res.redirect('/login');
  }
  console.log(`[Auth Success] User ${req.session.userId} (${req.session.username}) accessing ${req.method} ${req.path}`);
  next();
}

function checkAdmin(req, res, next) {
  if (!req.session.userId) {
    console.warn(`[Auth Error] Unauthenticated access attempt to admin ${req.method} ${req.path}`);
    // Always redirect to login
    return res.redirect('/login');
  }
  
  if (req.session.role !== 'admin') {
    console.warn(`[Auth Error] Non-admin user ${req.session.userId} (${req.session.username}) attempted admin access to ${req.method} ${req.path}`);
    // Redirect to dashboard for non-admin
    return res.redirect('/admin/dashboard');
  }
  console.log(`[Auth Success] Admin ${req.session.userId} (${req.session.username}) accessing ${req.method} ${req.path}`);
  next();
}

// ============= AUTH ROUTES =============

app.post('/api/login', (req, res) => {
  const { username, password } = req.body;
  console.log(`[Auth] Login attempt for username: ${username}`);
  
  db.get(`SELECT * FROM users WHERE username = ? AND is_active = 1`, [username], (err, user) => {
    if (err) {
      console.error(`[Auth Error] Login query failed for ${username}:`, err);
      return res.status(500).json({ error: err.message });
    }
    
    if (!user || !bcrypt.compareSync(password, user.password)) {
      console.warn(`[Auth Error] Invalid credentials for username: ${username}`);
      return res.status(401).json({ error: 'Invalid credentials' });
    }
    
    // Update last login
    db.run(`UPDATE users SET last_login = CURRENT_TIMESTAMP WHERE id = ?`, [user.id], (err) => {
      if (err) console.error('[DB Error] Failed to update last_login:', err);
    });
    
    req.session.userId = user.id;
    req.session.username = user.username;
    req.session.role = user.role;
    console.log(`[Auth Success] User ${user.id} (${user.username}) logged in with role: ${user.role}`);
    res.json({ success: true, user: { id: user.id, username: user.username, role: user.role } });
  });
});

app.post('/api/logout', (req, res) => {
  console.log(`[Auth] User ${req.session.userId} (${req.session.username}) logged out`);
  req.session.destroy(() => {
    console.log(`[Auth] Session destroyed`);
    res.json({ success: true });
  });
});

app.get('/api/auth/check', (req, res) => {
  if (req.session.userId) {
    res.json({ authenticated: true, user: { id: req.session.userId, username: req.session.username, role: req.session.role } });
  } else {
    res.json({ authenticated: false });
  }
});

// ============= OS TEMPLATES =============

app.get('/api/os-templates', (req, res) => {
  // First get database templates
  db.all(`SELECT * FROM os_templates WHERE is_active = 1 ORDER BY created_at DESC`, (err, dbTemplates) => {
    if (err || !dbTemplates) {
      // If error, return default built-in templates only
      return res.json(OS_TEMPLATES);
    }

    // Combine DB templates with built-in templates
    const dbTemplateMap = {};
    if (dbTemplates && dbTemplates.length > 0) {
      dbTemplates.forEach(t => {
        dbTemplateMap[t.template_key] = t;
      });
    }

    // Get built-in templates as object
    const allTemplates = { ...OS_TEMPLATES };
    
    // Add custom templates from DB
    if (dbTemplates && dbTemplates.length > 0) {
      dbTemplates.forEach(t => {
        allTemplates[t.template_key] = {
          template_key: t.template_key,
          name: t.template_name,
          type: t.template_type,
          icon: t.icon,
          disk_size: t.disk_size,
          memory: t.memory,
          cpus: t.cpus,
          username: t.username,
          password: t.password || 'password',
          url: t.download_url,
          is_custom: true
        };
      });
    }

    res.json(allTemplates);
  });
});

// Get all templates (admin) - includes inactive
app.get('/api/admin/templates', checkAuth, checkAdmin, (req, res) => {
  console.log(`[API] GET /api/admin/templates - Admin requesting all templates`);
  
  // Query custom templates from database
  db.all(`SELECT * FROM os_templates ORDER BY is_custom DESC, created_at DESC`, [], (err, dbTemplates) => {
    if (err) {
      console.error(`[API] GET /api/admin/templates - DB Query Error:`, err.message);
      return res.status(500).json({ 
        error: 'Database error', 
        message: err.message,
        status: 'error'
      });
    }

    // Build built-in templates list
    const builtInList = [];
    for (const [key, template] of Object.entries(OS_TEMPLATES)) {
      builtInList.push({
        template_id: null,
        template_key: key,
        template_name: template.name,
        template_type: template.type,
        icon: template.icon,
        description: `Built-in template for ${template.name}`,
        disk_size: template.disk_size,
        memory: template.memory,
        cpus: template.cpus,
        download_url: template.url,
        local_path: null,
        username: template.username,
        password: template.password,
        is_custom: 0,
        is_active: 1,
        created_at: null,
        created_by: null
      });
    }

    // Combine: custom templates + built-in templates
    const allTemplates = [];
    
    // Add custom templates first
    if (dbTemplates && Array.isArray(dbTemplates)) {
      dbTemplates.forEach(t => {
        allTemplates.push({
          template_id: t.template_id,
          template_key: t.template_key,
          template_name: t.template_name,
          template_type: t.template_type,
          icon: t.icon,
          description: t.description,
          disk_size: t.disk_size,
          memory: t.memory,
          cpus: t.cpus,
          download_url: t.download_url,
          local_path: t.local_path,
          username: t.username,
          password: t.password,
          is_custom: t.is_custom,
          is_active: t.is_active,
          created_at: t.created_at,
          created_by: t.created_by
        });
      });
    }
    
    // Add built-in templates
    allTemplates.push(...builtInList);

    console.log(`[API] GET /api/admin/templates - Returning ${allTemplates.length} templates (${dbTemplates ? dbTemplates.length : 0} custom + ${builtInList.length} built-in)`);
    res.json(allTemplates);
  });
});

// Create custom template
app.post('/api/admin/templates', checkAuth, checkAdmin, async (req, res) => {
  const { template_key, template_name, template_type, icon, description, disk_size, memory, cpus, download_url, username, password } = req.body;

  if (!template_key || !template_name) {
    return res.status(400).json({ error: 'Template key and name are required' });
  }

  if (!disk_size) {
    return res.status(400).json({ error: 'Disk size is required' });
  }

  // Check if template key already exists
  db.get(`SELECT * FROM os_templates WHERE template_key = ?`, [template_key], async (err, existing) => {
    if (existing) {
      return res.status(400).json({ error: 'Template with this key already exists' });
    }

    try {
      // Just store the template metadata - NO AUTO DOWNLOAD
      // User can download manually from templates list if needed
      const localPath = null; // Leave empty - user downloads manually

      // Insert into database
      db.run(
        `INSERT INTO os_templates 
        (template_key, template_name, template_type, icon, description, disk_size, memory, cpus, download_url, local_path, username, password, is_custom, created_by) 
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1, ?)`,
        [template_key, template_name, template_type || 'cloud-init', icon || '📦', description || '', disk_size, memory || 2048, cpus || 2, download_url || '', localPath || '', username || '', password || '', req.session.userId],
        function(err) {
          if (err) return res.status(500).json({ error: err.message });
          
          res.json({
            success: true,
            template_id: this.lastID,
            template_key,
            message: 'Template created successfully! Download it manually from the templates list if needed.'
          });
        }
      );
    } catch (error) {
      res.status(500).json({ error: 'Failed to create template: ' + error.message });
    }
  });
});

// Update template
app.put('/api/admin/templates/:id', checkAuth, checkAdmin, (req, res) => {
  const { template_name, icon, description, disk_size, memory, cpus, username, password, is_active } = req.body;
  const templateId = req.params.id;

  const updates = [];
  const values = [];

  if (template_name) { updates.push('template_name = ?'); values.push(template_name); }
  if (icon !== undefined) { updates.push('icon = ?'); values.push(icon || '📦'); }
  if (description !== undefined) { updates.push('description = ?'); values.push(description || ''); }
  if (disk_size) { updates.push('disk_size = ?'); values.push(disk_size); }
  if (memory) { updates.push('memory = ?'); values.push(memory); }
  if (cpus) { updates.push('cpus = ?'); values.push(cpus); }
  if (username) { updates.push('username = ?'); values.push(username); }
  if (password) { updates.push('password = ?'); values.push(password); }
  if (is_active !== undefined) { updates.push('is_active = ?'); values.push(is_active ? 1 : 0); }
  
  updates.push('updated_at = datetime("now")');

  if (updates.length === 1) { // Only updated_at
    return res.status(400).json({ error: 'No fields to update' });
  }

  values.push(templateId);
  const query = `UPDATE os_templates SET ${updates.join(', ')} WHERE template_id = ?`;

  db.run(query, values, (err) => {
    if (err) return res.status(500).json({ error: err.message });
    res.json({ success: true, message: 'Template updated successfully' });
  });
});

// Update Built-in Template (creates/updates in database)
app.put('/api/admin/templates/builtin/:key', checkAuth, checkAdmin, (req, res) => {
  const templateKey = req.params.key;
  const { template_name, icon, description, disk_size, memory, cpus, username, password } = req.body;

  if (!OS_TEMPLATES[templateKey]) {
    return res.status(404).json({ error: 'Built-in template not found' });
  }

  const builtIn = OS_TEMPLATES[templateKey];

  // Check if already exists in database
  db.get(`SELECT * FROM os_templates WHERE template_key = ?`, [templateKey], (err, existing) => {
    if (err) return res.status(500).json({ error: err.message });

    const finalData = {
      template_key: templateKey,
      template_name: template_name || builtIn.name,
      template_type: builtIn.type,
      icon: icon || builtIn.icon,
      description: description || `Built-in: ${builtIn.name}`,
      disk_size: disk_size || builtIn.disk_size,
      memory: memory || builtIn.memory,
      cpus: cpus || builtIn.cpus,
      download_url: builtIn.url,
      username: username || builtIn.username,
      password: password || builtIn.password,
      is_custom: 0
    };

    if (existing) {
      // Update existing
      db.run(
        `UPDATE os_templates SET 
         template_name = ?, icon = ?, description = ?, disk_size = ?, memory = ?, cpus = ?, 
         username = ?, password = ?, updated_at = datetime("now")
         WHERE template_key = ?`,
        [finalData.template_name, finalData.icon, finalData.description, finalData.disk_size, 
         finalData.memory, finalData.cpus, finalData.username, finalData.password, templateKey],
        (err) => {
          if (err) return res.status(500).json({ error: err.message });
          res.json({ success: true, message: 'Built-in template updated successfully' });
        }
      );
    } else {
      // Insert new
      db.run(
        `INSERT INTO os_templates 
         (template_key, template_name, template_type, icon, description, disk_size, memory, cpus, 
          download_url, username, password, is_custom, created_by) 
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 0, ?)`,
        [finalData.template_key, finalData.template_name, finalData.template_type, finalData.icon, 
         finalData.description, finalData.disk_size, finalData.memory, finalData.cpus, 
         finalData.download_url, finalData.username, finalData.password, 1],
        (err) => {
          if (err) return res.status(500).json({ error: err.message });
          res.json({ success: true, message: 'Built-in template saved successfully' });
        }
      );
    }
  });
});

// Delete template
app.delete('/api/admin/templates/:id', checkAuth, checkAdmin, (req, res) => {
  const templateId = req.params.id;

  db.get(`SELECT * FROM os_templates WHERE template_id = ?`, [templateId], (err, template) => {
    if (err || !template) return res.status(404).json({ error: 'Template not found' });

    // Delete local file if exists
    if (template.local_path && fs.existsSync(template.local_path)) {
      try {
        fs.unlinkSync(template.local_path);
      } catch (e) {
        console.error('Failed to delete template file:', e.message);
      }
    }

    // Delete from database
    db.run(`DELETE FROM os_templates WHERE template_id = ?`, [templateId], (err) => {
      if (err) return res.status(500).json({ error: err.message });
      res.json({ success: true, message: 'Template deleted successfully' });
    });
  });
});

// Download template file (get template by key)
app.post('/api/admin/templates/:key/download', checkAuth, checkAdmin, async (req, res) => {
  const templateKey = req.params.key;

  try {
    // Check if it's a built-in template
    if (OS_TEMPLATES[templateKey]) {
      const template = OS_TEMPLATES[templateKey];
      const fileName = `${templateKey}-template.qcow2`;
      const localPath = path.join(TEMPLATES_DIR, fileName);

      // Create templates directory if it doesn't exist
      if (!fs.existsSync(TEMPLATES_DIR)) {
        fs.mkdirSync(TEMPLATES_DIR, { recursive: true });
      }

      if (fs.existsSync(localPath)) {
        console.log(`[TEMPLATE] ${templateKey} already cached at ${localPath}`);
        return res.json({ success: true, message: 'Template already cached locally', local_path: localPath });
      }

      console.log(`[TEMPLATE] Starting download of ${templateKey} from ${template.url}`);

      // Download the template
      await downloadTemplateFromURL(template.url, localPath);

      console.log(`[TEMPLATE] Download complete for ${templateKey}`);

      // Save to database
      db.run(
        `INSERT OR REPLACE INTO os_templates 
        (template_key, template_name, template_type, icon, description, disk_size, memory, cpus, download_url, local_path, username, password, is_custom) 
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 0)`,
        [templateKey, template.name, template.type, template.icon, `Built-in: ${template.name}`, template.disk_size, template.memory, template.cpus, template.url, localPath, template.username, template.password],
        (err) => {
          if (err) console.error('Failed to save template to database:', err);
          res.json({ success: true, message: 'Template downloaded and cached', local_path: localPath });
        }
      );
    } else {
      // Custom template
      db.get(`SELECT * FROM os_templates WHERE template_key = ?`, [templateKey], async (err, template) => {
        if (err || !template) return res.status(404).json({ error: 'Template not found' });
        
        // Create templates directory if it doesn't exist
        if (!fs.existsSync(TEMPLATES_DIR)) {
          fs.mkdirSync(TEMPLATES_DIR, { recursive: true });
        }

        // Generate local path if not set
        let localPath = template.local_path;
        if (!localPath) {
          // Extract filename from URL or use template key
          const urlParts = template.download_url.split('/');
          const fileName = urlParts[urlParts.length - 1] || `${templateKey}-template.qcow2`;
          localPath = path.join(TEMPLATES_DIR, fileName);
        }

        if (fs.existsSync(localPath)) {
          console.log(`[TEMPLATE] Custom template ${templateKey} already cached at ${localPath}`);
          
          // Update database with local path if not set
          if (!template.local_path) {
            db.run(`UPDATE os_templates SET local_path = ? WHERE template_key = ?`, 
              [localPath, templateKey], 
              (err) => {
                if (err) console.error('Failed to update template path:', err);
              }
            );
          }
          
          return res.json({ success: true, message: 'Template cached locally', local_path: localPath });
        }

        // Download the template
        try {
          console.log(`[TEMPLATE] Starting download of custom template (${templateKey}) from ${template.download_url}`);
          console.log(`[TEMPLATE] Saving to: ${localPath}`);
          
          await downloadTemplateFromURL(template.download_url, localPath);
          
          console.log(`[TEMPLATE] Download complete for custom template ${templateKey}`);

          // Update database with local path
          db.run(`UPDATE os_templates SET local_path = ? WHERE template_key = ?`, 
            [localPath, templateKey], 
            (err) => {
              if (err) console.error('Failed to update template path:', err);
            }
          );

          res.json({ success: true, message: 'Template downloaded and cached', local_path: localPath });
        } catch (downloadErr) {
          console.error(`[TEMPLATE] Download error for ${templateKey}:`, downloadErr.message);
          res.status(500).json({ error: 'Failed to download template: ' + downloadErr.message });
        }
      });
    }
  } catch (error) {
    console.error(`[TEMPLATE] Error:`, error.message);
    res.status(500).json({ error: 'Failed to download template: ' + error.message });
  }
});

// Get template cache info
app.get('/api/admin/templates/cache/info', checkAuth, checkAdmin, (req, res) => {
  try {
    const templates = [];
    
    if (fs.existsSync(TEMPLATES_DIR)) {
      const files = fs.readdirSync(TEMPLATES_DIR);
      files.forEach(file => {
        const filePath = path.join(TEMPLATES_DIR, file);
        const stat = fs.statSync(filePath);
        templates.push({
          filename: file,
          size: stat.size,
          size_readable: (stat.size / (1024 * 1024 * 1024)).toFixed(2) + ' GB',
          created: stat.birthtime,
          modified: stat.mtime
        });
      });
    }

    res.json({
      cache_directory: TEMPLATES_DIR,
      templates: templates,
      total_count: templates.length,
      total_size: templates.reduce((sum, t) => sum + t.size, 0),
      total_size_readable: (templates.reduce((sum, t) => sum + t.size, 0) / (1024 * 1024 * 1024)).toFixed(2) + ' GB'
    });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// Clear template cache (admin only)
app.post('/api/admin/templates/cache/clear', checkAuth, checkAdmin, (req, res) => {
  try {
    if (!fs.existsSync(TEMPLATES_DIR)) {
      return res.json({ success: true, message: 'Cache directory does not exist' });
    }

    const files = fs.readdirSync(TEMPLATES_DIR);
    let deleted = 0;
    let errors = [];

    files.forEach(file => {
      const filePath = path.join(TEMPLATES_DIR, file);
      try {
        fs.unlinkSync(filePath);
        deleted++;
      } catch (e) {
        errors.push(file + ': ' + e.message);
      }
    });

    res.json({
      success: true,
      deleted: deleted,
      errors: errors.length > 0 ? errors : null,
      message: `Cleared ${deleted} cached templates`
    });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// Get CPU Models
app.get('/api/cpu-models', (req, res) => {
  res.json(CPU_MODELS);
});

// Get SMBIOS options
app.get('/api/smbios', (req, res) => {
  res.json({
    manufacturers: SMBIOS_MANUFACTURERS,
    products: SMBIOS_PRODUCTS
  });
});

// Get Network Types
app.get('/api/network-types', (req, res) => {
  res.json(NETWORK_TYPES);
});

// Get DNS Providers
app.get('/api/dns-providers', (req, res) => {
  res.json(DNS_PROVIDERS);
});

// List available ISO files
app.get('/api/iso-list', (req, res) => {
  try {
    const files = fs.readdirSync(ISO_DIR).filter(f => f.endsWith('.iso'));
    res.json(files);
  } catch (error) {
    res.json([]);
  }
});

// ============= VIEW ROUTES (EJS Pages) =============

// Favicon endpoint
app.get('/favicon.ico', (req, res) => {
  res.redirect('/public/images/logo.png');
});

// Middleware to pass user and settings to all views
app.use((req, res, next) => {
  // Set defaults first
  res.locals.user = req.session.userId ? {
    id: req.session.userId,
    username: req.session.username,
    role: req.session.role
  } : null;
  
  // Panel version from .env
  res.locals.panelVersion = process.env.PANEL_VERSION || 'V1.0';
  
  // Set default logo and site name
  res.locals.siteLogo = process.env.DEFAULT_LOGO_URL || 'https://i.imgur.com/0DmkSi4.png';
  res.locals.siteName = process.env.PANEL_NAME || 'HKVM Panel';
  
  // Try to get site icon from database (non-blocking)
  db.get(`SELECT setting_value FROM settings WHERE setting_key = 'site_icon_url' LIMIT 1`, (err, row) => {
    if (row && row.setting_value) {
      res.locals.siteLogo = row.setting_value;
    }
  });
  
  // Try to get site name from database (non-blocking)
  db.get(`SELECT setting_value FROM settings WHERE setting_key = 'site_name' LIMIT 1`, (err, row2) => {
    if (row2 && row2.setting_value) {
      res.locals.siteName = row2.setting_value;
    }
  });
  
  next();
});

// License check middleware - redirect to activation page if license is not active
app.use(async (req, res, next) => {
  // Routes that don't require license check
  const exemptRoutes = ['/login', '/license_activation', '/api/license', '/favicon.ico', '/public', '/api/admin'];
  const isExempt = exemptRoutes.some(route => req.path.startsWith(route));
  
  if (isExempt) {
    return next();
  }
  
  try {
    const isLicenseActive = await licenses.isActivated();
    
    if (!isLicenseActive) {
      // If it's an API call, return JSON error
      if (req.path.startsWith('/api/')) {
        return res.status(403).json({
          error: 'License not active',
          message: 'Please activate your license to access this feature',
          redirect: '/license_activation'
        });
      }
      
      // For page requests, redirect to license activation
      return res.redirect('/license_activation');
    }
    
    next();
  } catch (error) {
    console.error('[License] Error checking license status:', error);
    // On error, allow access to prevent system lockout
    next();
  }
});

// Login page
app.get('/login', (req, res) => {
  if (req.session.userId) {
    return res.redirect('/dashboard');
  }
  res.render('users/login', { 
    title: 'Login - HKVM Panel',
    currentPage: 'login',
    siteLogo: res.locals.siteLogo || process.env.DEFAULT_LOGO_URL || 'https://i.imgur.com/0DmkSi4.png',
    siteName: res.locals.siteName || process.env.PANEL_NAME || 'HKVM Panel'
  });
});



// License Activation Page
app.get('/license_activation', async (req, res) => {
  try {
    // Check if license is already active
    const isActive = await licenses.isActivated();
    
    if (isActive) {
      // License is already active - redirect to dashboard or referrer
      const referrer = req.headers.referer || '/dashboard';
      return res.redirect(referrer);
    }
    
    // License is not active - show activation page
    const machineId = await licenses.getMachineId();
    res.render('license_activation', {
      title: 'Activate License - HKVM Panel',
      currentPage: 'license_activation',
      siteLogo: res.locals.siteLogo || process.env.DEFAULT_LOGO_URL || 'https://i.imgur.com/0DmkSi4.png',
      siteName: res.locals.siteName || process.env.PANEL_NAME || 'HKVM Panel',
      machineId: machineId.substring(0, 16) + '...',
      fullMachineId: machineId
    });
  } catch (error) {
    console.error('[License] Error checking license activation status:', error);
    // On error, show activation page
    const machineId = await licenses.getMachineId();
    res.render('license_activation', {
      title: 'Activate License - HKVM Panel',
      currentPage: 'license_activation',
      siteLogo: res.locals.siteLogo || process.env.DEFAULT_LOGO_URL || 'https://i.imgur.com/0DmkSi4.png',
      siteName: res.locals.siteName || process.env.PANEL_NAME || 'HKVM Panel',
      machineId: machineId.substring(0, 16) + '...',
      fullMachineId: machineId
    });
  }
});

// License Activation - POST endpoint
app.post('/api/license/activate', async (req, res) => {
  try {
    const { license_key } = req.body;
    
    if (!license_key || typeof license_key !== 'string') {
      return res.status(400).json({
        success: false,
        message: 'License key is required'
      });
    }
    
    // Attempt to activate the license
    const result = await licenses.activateWithServer(license_key, 'web');
    
    if (result.success) {
      return res.json({
        success: true,
        message: result.message,
        redirect: '/login'
      });
    } else {
      return res.status(400).json({
        success: false,
        message: result.message || 'Failed to activate license'
      });
    }
  } catch (error) {
    console.error('[License] Error activating license:', error);
    return res.status(500).json({
      success: false,
      message: 'An error occurred while activating your license: ' + error.message
    });
  }
});

// Dashboard - Normal users only
app.get('/dashboard', checkAuth, (req, res) => {
  // Show user dashboard (works for both regular users and admins)
  res.render('users/dashboard', {
    title: 'My VMs - HKVM Panel',
    currentPage: 'dashboard',
    user: {
      username: req.session.username,
      role: req.session.role
    }
  });
});
// Admin Dashboard - Admin only
app.get('/admin/dashboard', checkAuth, checkAdmin, (req, res) => {
  res.render('admin/dashboard', {
    title: 'Dashboard - HKVM Panel',
    currentPage: 'dashboard',
    user: {
      username: req.session.username,
      role: req.session.role
    }
  });
});

// Virtual Machines list (Admin only)
app.get('/admin/vms', checkAuth, checkAdmin, (req, res) => {
  res.render('admin/vms', {
    title: 'Virtual Machines - HKVM Panel',
    currentPage: 'vms'
  });
});

// Create VM (Admin only)
app.get('/admin/vm-create', checkAuth, checkAdmin, (req, res) => {
  res.render('admin/vm-create', {
    title: 'Create Virtual Machine - HKVM Panel',
    currentPage: 'vm-create',
    user: {
      username: req.session.username,
      role: req.session.role
    }
  });
});

// VM Details (Admin only)
app.get('/admin/vm/:id', checkAuth, checkAdmin, (req, res) => {
  res.render('admin/vm-detail', {
    title: 'VM Details - HKVM Panel',
    currentPage: 'vm-detail',
    vmId: req.params.id
  });
});

// VM Console (Admin only)
app.get('/admin/vm/:id/console', checkAuth, checkAdmin, (req, res) => {
  res.render('admin/vm-console', {
    title: 'VM Console - HKVM Panel',
    currentPage: 'vm-console',
    vmId: req.params.id
  });
});

// VM Edit Configuration Page (Admin only)
app.get('/admin/vm/:id/edit', checkAuth, checkAdmin, (req, res) => {
  db.get(`SELECT * FROM vms WHERE vm_id = ?`, [req.params.id], (err, vm) => {
    if (err || !vm) return res.status(404).render('users/404', { message: 'VM not found' });
    
    res.render('admin/vm-edit', {
      title: 'Edit VM - HKVM Panel',
      currentPage: 'vm-edit',
      vmId: req.params.id,
      vm: vm
    });
  });
});

// Users management (admin only)
app.get('/admin/users', checkAuth, checkAdmin, (req, res) => {
  res.render('admin/users', {
    title: 'Users - HKVM Panel',
    currentPage: 'users'
  });
});

// Create new user page (admin only)
app.get('/admin/users/create', checkAuth, checkAdmin, (req, res) => {
  res.render('admin/users-create', {
    title: 'Create User - HKVM Panel',
    currentPage: 'users'
  });
});

// Edit user page (admin only)
app.get('/admin/users/:id/edit', checkAuth, checkAdmin, (req, res) => {
  const userId = parseInt(req.params.id);
  if (isNaN(userId)) {
    return res.status(400).render('admin/404', { title: 'Invalid User ID' });
  }
  
  res.render('admin/users-edit', {
    title: 'Edit User - HKVM Panel',
    currentPage: 'users',
    userId: userId
  });
});

// Settings (admin only)
app.get('/admin/settings', checkAuth, checkAdmin, (req, res) => {
  res.render('admin/settings', {
    title: 'Settings - HKVM Panel',
    currentPage: 'settings'
  });
});

// OS Templates Management (admin only)
app.get('/admin/templates', checkAuth, checkAdmin, (req, res) => {
  res.render('admin/templates', {
    title: 'OS Templates - HKVM Panel',
    currentPage: 'templates'
  });
});

// Add OS Template (admin only)
app.get('/admin/templates/add', checkAuth, checkAdmin, (req, res) => {
  res.render('admin/templates-add', {
    title: 'Add OS Template - HKVM Panel',
    currentPage: 'templates'
  });
});

// Edit Built-in OS Template (admin only)
app.get('/admin/templates/builtin/:key/edit', checkAuth, checkAdmin, (req, res) => {
  const templateKey = req.params.key;
  console.log(`[ROUTE] GET /admin/templates/builtin/${templateKey}/edit`);
  
  if (!OS_TEMPLATES[templateKey]) {
    console.error(`[ERROR] Template key not found: ${templateKey}`);
    return res.status(400).render('admin/404', { title: 'Built-in Template Not Found' });
  }
  
  const template = OS_TEMPLATES[templateKey];
  console.log(`[SUCCESS] Found built-in template: ${template.name}`);
  
  // Build template object for display
  const templateObj = {
    template_key: templateKey,
    template_name: template.name,
    template_type: template.type,
    icon: template.icon,
    description: `Built-in template for ${template.name}`,
    disk_size: template.disk_size,
    memory: template.memory,
    cpus: template.cpus,
    download_url: template.url,
    username: template.username,
    password: template.password,
    is_custom: 0,
    is_builtin: 1
  };
  
  res.render('admin/templates-edit', {
    title: `View ${template.name} - HKVM Panel`,
    currentPage: 'templates',
    siteLogo: res.locals.siteLogo || 'https://i.imgur.com/0DmkSi4.png',
    templateKey: templateKey,
    isBuiltin: true,
    template: templateObj
  });
});

// ============= USER ROUTES (Non-Admin Users) =============

// User VMs list
app.get('/vms', checkAuth, (req, res) => {
  res.render('users/vms', {
    title: 'My Virtual Machines - HKVM Panel',
    currentPage: 'vms',
    user: {
      username: req.session.username,
      role: req.session.role
    }
  });
});

// User VM detail page
app.get('/vm/:id', checkAuth, (req, res) => {
  res.render('users/vm-detail', {
    title: 'VM Details - HKVM Panel',
    currentPage: 'vm-detail',
    vmId: req.params.id,
    userId: req.session.userId,
    user: {
      username: req.session.username,
      role: req.session.role
    }
  });
});

// User VM console page
app.get('/vm/:id/console', checkAuth, (req, res) => {
  res.render('users/vm-console', {
    title: 'VM Console - HKVM Panel',
    currentPage: 'vm-console',
    vmId: req.params.id,
    userId: req.session.userId,
    user: {
      username: req.session.username,
      role: req.session.role
    }
  });
});

// User VM SSH connection page
app.get('/vm/:id/ssh', checkAuth, (req, res) => {
  res.render('users/vm-ssh', {
    title: 'SSH Connection - HKVM Panel',
    currentPage: 'vm-ssh',
    vmId: req.params.id,
    userId: req.session.userId,
    user: {
      username: req.session.username,
      role: req.session.role
    }
  });
});

// Admin VM SSH connection page
app.get('/admin/vm/:id/ssh', checkAuth, checkAdmin, (req, res) => {
  res.render('admin/vm-ssh', {
    title: 'SSH Connection - HKVM Admin Panel',
    currentPage: 'vm-ssh',
    vmId: req.params.id,
    userId: req.session.userId,
    user: {
      username: req.session.username,
      role: req.session.role
    }
  });
});

// User profile page
app.get('/profile', checkAuth, (req, res) => {
  res.render('users/profile', {
    title: 'My Profile - HKVM Panel',
    currentPage: 'profile',
    user: {
      username: req.session.username,
      role: req.session.role,
      userId: req.session.userId
    }
  });
});

// ============= API ROUTES =============

// Get list of users for dropdown/assignment (accessible to admins)
app.get('/api/users/list', checkAuth, checkAdmin, (req, res) => {
  db.all(`SELECT id, username, email, role FROM users WHERE is_active = 1 ORDER BY username`, (err, users) => {
    if (err) return res.status(500).json({ error: err.message });
    res.json(users);
  });
});

app.get('/api/admin/users', checkAuth, checkAdmin, (req, res) => {
  db.all(`SELECT id, username, email, role, created_at, is_active FROM users`, (err, users) => {
    if (err) return res.status(500).json({ error: err.message });
    res.json(users);
  });
});

// Get single user
app.get('/api/admin/users/:id', checkAuth, checkAdmin, (req, res) => {
  const userId = parseInt(req.params.id);
  db.get(`SELECT id, username, email, full_name, role, created_at, is_active FROM users WHERE id = ?`, [userId], (err, user) => {
    if (err) return res.status(500).json({ error: err.message });
    if (!user) return res.status(404).json({ error: 'User not found' });
    res.json(user);
  });
});

app.post('/api/admin/users', checkAuth, checkAdmin, (req, res) => {
  const { username, password, email, full_name, role } = req.body;
  
  if (!username || !password) {
    return res.status(400).json({ error: 'Username and password are required' });
  }
  
  const hashedPassword = bcrypt.hashSync(password, 10);
  db.run(
    `INSERT INTO users (username, password, email, full_name, role, is_active) VALUES (?, ?, ?, ?, ?, 1)`,
    [username, hashedPassword, email || null, full_name || null, role || 'user'],
    function(err) {
      if (err) {
        if (err.message.includes('UNIQUE constraint failed')) {
          return res.status(400).json({ error: 'Username already exists' });
        }
        return res.status(500).json({ error: err.message });
      }
      res.json({ success: true, id: this.lastID });
    }
  );
});

// Update user
app.put('/api/admin/users/:id', checkAuth, checkAdmin, (req, res) => {
  const userId = parseInt(req.params.id);
  const { email, full_name, password, role, is_active } = req.body;
  
  if (userId === 1 && role && role !== 'admin') {
    return res.status(400).json({ error: 'Default admin must remain an admin' });
  }
  
  let query = 'UPDATE users SET ';
  let values = [];
  
  if (email !== undefined) {
    query += 'email = ?, ';
    values.push(email);
  }
  
  if (full_name !== undefined) {
    query += 'full_name = ?, ';
    values.push(full_name);
  }
  
  if (password) {
    if (password.length < 6) {
      return res.status(400).json({ error: 'Password must be at least 6 characters' });
    }
    query += 'password = ?, ';
    values.push(bcrypt.hashSync(password, 10));
  }
  
  if (role !== undefined) {
    query += 'role = ?, ';
    values.push(role);
  }
  
  if (is_active !== undefined) {
    query += 'is_active = ?, ';
    values.push(is_active ? 1 : 0);
  }
  
  query = query.slice(0, -2); // Remove trailing comma and space
  query += ' WHERE id = ?';
  values.push(userId);
  
  db.run(query, values, (err) => {
    if (err) {
      if (err.message.includes('UNIQUE constraint failed')) {
        return res.status(400).json({ error: 'Email already exists' });
      }
      return res.status(500).json({ error: err.message });
    }
    res.json({ success: true });
  });
});

app.delete('/api/admin/users/:id', checkAuth, checkAdmin, (req, res) => {
  if (req.params.id === '1') {
    return res.status(400).json({ error: 'Cannot delete default admin' });
  }
  db.run(`DELETE FROM users WHERE id = ?`, [req.params.id], (err) => {
    if (err) return res.status(500).json({ error: err.message });
    res.json({ success: true });
  });
});

// ============= VM MANAGEMENT (VM ID BASED) =============

app.get('/api/vms', checkAuth, (req, res) => {
  const userId = req.session.userId;
  
  // User pages always show ONLY the logged-in user's own VMs
  // (even if user is admin - they see their own VMs, not all VMs)
  // For all VMs, use /api/admin/vms endpoint
  let query = `SELECT vms.*, COALESCE(t.icon, '⚫') as template_icon, COALESCE(t.template_name, vms.os_type) as template_name
              FROM vms 
              LEFT JOIN os_templates t ON vms.template_type = t.template_key
              WHERE vms.owner_id = ?
              ORDER BY vms.vm_id DESC`;
  let params = [userId];
  
  db.all(query, params, (err, vms) => {
    if (err) {
      console.error('[API Error] /api/vms:', err);
      return res.status(500).json({ error: err.message });
    }
    console.log(`[API Success] /api/vms: User ${userId} (${req.session.role}) fetched ${vms ? vms.length : 0} VMs (own VMs only)`);
    res.json(vms || []);
  });
});

// Admin API endpoint: Get all VMs for admin pages
app.get('/api/admin/vms', checkAuth, checkAdmin, (req, res) => {
  const userId = req.session.userId;
  
  // Admin pages can see ALL VMs in the system
  let query = `SELECT vms.*, COALESCE(t.icon, '⚫') as template_icon, COALESCE(t.template_name, vms.os_type) as template_name
              FROM vms 
              LEFT JOIN os_templates t ON vms.template_type = t.template_key
              ORDER BY vms.vm_id DESC`;
  let params = [];
  
  db.all(query, params, (err, vms) => {
    if (err) {
      console.error('[API Error] /api/admin/vms:', err);
      return res.status(500).json({ error: err.message });
    }
    console.log(`[API Success] /api/admin/vms: Admin ${userId} fetched ${vms ? vms.length : 0} VMs (all VMs)`);
    res.json(vms || []);
  });
});

app.get('/api/vms/:vm_id', checkAuth, (req, res) => {
  const userId = req.session.userId;
  let query = `
    SELECT 
      vms.*,
      COALESCE(ot.icon, '⚫') as template_icon
    FROM vms
    LEFT JOIN os_templates ot ON vms.template_type = ot.template_key
    WHERE vms.vm_id = ?
  `;
  let params = [req.params.vm_id];
  
  // Normal users can only see their own VMs
  if (req.session.role !== 'admin') {
    query += ` AND vms.owner_id = ?`;
    params.push(userId);
  }
  
  db.get(query, params, (err, vm) => {
    if (err || !vm) return res.status(404).json({ error: 'VM not found or access denied' });
    res.json(vm);
  });
});

// VM CONSOLE - Stream last 100 lines of VM serial output
app.get('/api/vms/:vm_id/console', checkAuth, (req, res) => {
  const vm_id = req.params.vm_id;
  const logFile = path.join(VM_DIR, `vm-${vm_id}.log`);
  
  if (!fs.existsSync(logFile)) {
    return res.json({ vm_id: vm_id, logs: 'Console not available yet', lines: 0 });
  }
  
  try {
    const logs = fs.readFileSync(logFile, 'utf8');
    const lines = logs.split('\n');
    const last100 = lines.slice(-100).join('\n');
    res.json({
      vm_id: vm_id,
      logs: last100,
      total_lines: lines.length
    });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// VM CONSOLE COMMAND - Send command to VM via serial console
app.post('/api/vms/:vm_id/console/command', checkAuth, async (req, res) => {
  const vm_id = req.params.vm_id;
  const { command } = req.body;
  const userId = req.session.userId;

  if (!command) {
    return res.status(400).json({ error: 'Command required' });
  }

  let query = `SELECT * FROM vms WHERE vm_id = ?`;
  let params = [vm_id];
  
  // Normal users can only send commands to their own VMs
  if (req.session.role !== 'admin') {
    query += ` AND owner_id = ?`;
    params.push(userId);
  }

  db.get(query, params, async (err, vm) => {
    if (err || !vm) return res.status(404).json({ error: 'VM not found or access denied' });

    if (vm.status !== 'running') {
      return res.status(400).json({ error: 'VM is not running' });
    }

    try {
      // Command is sent via WebSocket to console
      // Append to log so it appears in console
      const logFile = path.join(VM_DIR, `vm-${vm_id}.log`);
      fs.appendFileSync(logFile, command);
      
      console.log(`[VM-${vm_id}] Command executed: ${command}`);
      res.json({ 
        success: true, 
        message: 'Command sent to VM console',
        command: command,
        vmId: vm_id
      });
    } catch (error) {
      console.error(`[VM-${vm_id}] Error sending command:`, error.message);
      res.status(500).json({ error: 'Failed to send command: ' + error.message });
    }
  });
});

// GET VM EDIT CONFIG (retrieve editable fields)
app.get('/api/vms/:vm_id/edit', checkAuth, (req, res) => {
  db.get(`SELECT * FROM vms WHERE vm_id = ?`, [req.params.vm_id], (err, vm) => {
    if (err || !vm) return res.status(404).json({ error: 'VM not found' });
    
    // Return editable fields
    res.json({
      vm_id: vm.vm_id,
      vm_name: vm.vm_name,
      hostname: vm.hostname,
      memory: vm.memory,
      cpus: vm.cpus,
      cpu_sockets: vm.cpu_sockets,
      cpu_cores: vm.cpu_cores,
      cpu_threads: vm.cpu_threads,
      cpu_model: vm.cpu_model,
      disk_size: vm.disk_size,
      status: vm.status,
      enable_acpi: vm.enable_acpi,
      enable_kvm: vm.enable_kvm,
      extra_args: vm.extra_args,
      network_type: vm.network_type,
      ipv4_address: vm.ipv4_address,
      ipv4_gateway: vm.ipv4_gateway,
      ipv4_netmask: vm.ipv4_netmask,
      dns_primary: vm.dns_primary,
      dns_secondary: vm.dns_secondary,
      ipv6_address: vm.ipv6_address,
      ipv6_gateway: vm.ipv6_gateway,
      mac_address: vm.mac_address,
      vlan_id: vm.vlan_id,
      can_edit: vm.status === 'stopped'
    });
  });
});

// Resize disk qcow2 file (expand or shrink)
async function resizeDisk(vm_id, diskFilePath, newSize) {
  return new Promise((resolve, reject) => {
    try {
      if (!fs.existsSync(diskFilePath)) {
        return reject(new Error('Disk file not found'));
      }

      // Parse size to bytes (handle G, GB, T, TB)
      const parseSize = (sizeStr) => {
        const match = sizeStr.match(/^(\d+(?:\.\d+)?)\s*([KMGT]?B?)$/i);
        if (!match) return null;
        
        let size = parseFloat(match[1]);
        const unit = (match[2] || '').toUpperCase();
        
        const multipliers = { 'K': 1024, 'M': 1024**2, 'G': 1024**3, 'T': 1024**4 };
        if (unit.startsWith('K')) size *= multipliers['K'];
        else if (unit.startsWith('M')) size *= multipliers['M'];
        else if (unit.startsWith('G')) size *= multipliers['G'];
        else if (unit.startsWith('T')) size *= multipliers['T'];
        
        return Math.floor(size);
      };

      const newSizeBytes = parseSize(newSize);
      if (!newSizeBytes) {
        return reject(new Error('Invalid size format. Use: 20G, 100GB, 1T, etc.'));
      }

      // Get current disk size from qemu-img (not file size, but virtual size)
      let currentSize;
      try {
        const infoOutput = execSync(`qemu-img info "${diskFilePath}" --output=json`, { stdio: 'pipe', encoding: 'utf8' });
        const imageInfo = JSON.parse(infoOutput);
        currentSize = imageInfo['virtual-size'] || imageInfo['VirtualSize'] || 0;
        console.log(`[DISK-${vm_id}] Detected via qemu-img: Virtual size = ${(currentSize / (1024**3)).toFixed(2)}GB`);
      } catch (err) {
        console.warn(`[DISK-${vm_id}] Could not get size from qemu-img, falling back to file size`);
        const stats = fs.statSync(diskFilePath);
        currentSize = stats.size;
      }

      console.log(`[DISK-${vm_id}] Current: ${(currentSize / (1024**3)).toFixed(2)}GB, Target: ${(newSizeBytes / (1024**3)).toFixed(2)}GB`);

      if (newSizeBytes === currentSize) {
        return resolve({ message: 'size unchanged' });
      }

      // Determine if we're expanding or shrinking
      const isShrink = newSizeBytes < currentSize;
      const operation = isShrink ? 'shrink' : 'expand';

      // Use qemu-img to resize - always use +SIZE syntax for expand, =SIZE for shrink
      let resizeCmd;
      if (isShrink) {
        // Shrinking requires --shrink flag and = syntax
        resizeCmd = `qemu-img resize --shrink "${diskFilePath}" ${newSize}`;
      } else {
        // Expanding - use = syntax (not + syntax)
        resizeCmd = `qemu-img resize "${diskFilePath}" ${newSize}`;
      }

      console.log(`[DISK-${vm_id}] ${operation.toUpperCase()}: Executing: ${resizeCmd}`);
      
      // Execute and capture both stdout and stderr
      let output;
      try {
        output = execSync(resizeCmd, { stdio: 'pipe', encoding: 'utf8', shell: true });
        console.log(`[DISK-${vm_id}] Command output: ${output}`);
      } catch (execErr) {
        // Check if it's just a warning
        const stderr = execErr.stderr ? execErr.stderr.toString() : '';
        const stdout = execErr.stdout ? execErr.stdout.toString() : '';
        
        // If it's a shrink warning, it might still work
        if (isShrink && stderr.includes('Shrinking an image')) {
          console.log(`[DISK-${vm_id}] Shrink warning (expected):`, stderr);
        } else {
          throw execErr;
        }
      }

      console.log(`[DISK-${vm_id}] Disk ${operation}ed to ${newSize}`);
      resolve({ message: `${operation}ed to ${newSize}` });
    } catch (err) {
      reject(err);
    }
  });
}

// Regenerate cloud-init seed for a VM
async function createCloudInitSeed(vm_id, vmData) {
  return new Promise(async (resolve, reject) => {
    try {
      const seedDir = path.join(VM_DIR, `seed-${vm_id}`);
      const seedIso = path.join(VM_DIR, `vm-${vm_id}-seed.iso`);
      const metaDataFile = path.join(seedDir, 'meta-data');
      const userDataFile = path.join(seedDir, 'user-data');
      const networkConfigFile = path.join(seedDir, 'network-config');

      // Recreate seed directory
      if (fs.existsSync(seedDir)) {
        fs.rmSync(seedDir, { recursive: true, force: true });
      }
      fs.mkdirSync(seedDir, { recursive: true });

      const metaData = `instance-id: ${vmData.vm_id}
local-hostname: ${vmData.hostname}
`;

      // Network config (v2 format for cloud-init with netplan)
      const networkConfig = `version: 2
ethernets:
  eth0:
    dhcp4: true
    dhcp6: false
    optional: true
`;

      // Generate updated cloud-init configuration
      const userData = generateCloudInitConfig(vmData);

      // Write configuration files
      fs.writeFileSync(metaDataFile, metaData, 'utf8');
      fs.writeFileSync(userDataFile, userData, 'utf8');
      fs.writeFileSync(networkConfigFile, networkConfig, 'utf8');

      console.log(`[CLOUDINIT-${vm_id}] Configuration files written`);

      // Create ISO
      try {
        const isoCommand = process.platform === 'win32'
          ? `mkisofs -output "${seedIso}" -volid cidata -joliet -rock "${seedDir}"`
          : `mkisofs -output "${seedIso}" -volid cidata -joliet -rock "${seedDir}"`;
        
        execSync(isoCommand, { stdio: 'pipe', shell: process.platform === 'win32' ? 'cmd' : '/bin/bash' });
      } catch (err) {
        try {
          const isoCommand = process.platform === 'win32'
            ? `cloud-localds "${seedIso}" "${userDataFile}" "${metaDataFile}"`
            : `cloud-localds "${seedIso}" "${userDataFile}" "${metaDataFile}"`;
          
          execSync(isoCommand, { stdio: 'pipe', shell: process.platform === 'win32' ? 'cmd' : '/bin/bash' });
        } catch (fallbackErr) {
          console.warn(`[CLOUDINIT-${vm_id}] ISO creation tools not available`);
        }
      }

      // Clean up temp directory
      fs.rmSync(seedDir, { recursive: true, force: true });

      console.log(`[CLOUDINIT-${vm_id}] Seed ISO created: ${seedIso}`);
      resolve({ message: 'Cloud-init seed regenerated' });
    } catch (err) {
      reject(err);
    }
  });
}

// UPDATE VM CONFIGURATION (PUT request)
app.put('/api/vms/:vm_id/edit', checkAuth, (req, res) => {
  const vm_id = req.params.vm_id;
  const userId = req.session.userId;
  const {
    vm_name, hostname, memory, cpus, cpu_sockets, cpu_cores, cpu_threads, cpu_model,
    custom_cpu_name, username, password,
    disk_size, enable_acpi, enable_kvm, extra_args,
    network_type, ipv4_address, ipv4_gateway, ipv4_netmask,
    dns_primary, dns_secondary, ipv6_address, ipv6_gateway, mac_address, vlan_id,
    machine_type, board_name, product_name, custom_smbios_manufacturer,
    smbios_manufacturer, smbios_product, smbios_version, smbios_serial,
    ssh_port, ssh_port_static,
    owner_id
  } = req.body;

  let query = `SELECT status FROM vms WHERE vm_id = ?`;
  let params = [vm_id];
  
  // Normal users can only edit their own VMs
  if (req.session.role !== 'admin') {
    query += ` AND owner_id = ?`;
    params.push(userId);
  }

  db.get(query, params, (err, vm) => {
    if (err || !vm) return res.status(404).json({ error: 'VM not found or access denied' });
    
    // Only allow editing stopped VMs
    if (vm.status !== 'stopped') {
      return res.status(400).json({ error: 'VM must be stopped to edit configuration' });
    }

    // Validate inputs
    const validatedMemory = memory && memory >= 512 ? memory : undefined;
    const validatedCpus = cpus && cpus >= 1 && cpus <= 128 ? cpus : undefined;
    const validatedSockets = cpu_sockets && cpu_sockets >= 1 && cpu_sockets <= 16 ? cpu_sockets : undefined;
    const validatedCores = cpu_cores && cpu_cores >= 1 && cpu_cores <= 64 ? cpu_cores : undefined;
    const validatedThreads = cpu_threads && cpu_threads >= 1 && cpu_threads <= 2 ? cpu_threads : undefined;

    // Build update query dynamically
    const updates = [];
    const values = [];

    if (vm_name) { updates.push('vm_name = ?'); values.push(vm_name); }
    if (hostname) { updates.push('hostname = ?'); values.push(hostname); }
    if (validatedMemory) { updates.push('memory = ?'); values.push(validatedMemory); }
    if (validatedCpus) { updates.push('cpus = ?'); values.push(validatedCpus); }
    if (validatedSockets) { updates.push('cpu_sockets = ?'); values.push(validatedSockets); }
    if (validatedCores) { updates.push('cpu_cores = ?'); values.push(validatedCores); }
    if (validatedThreads) { updates.push('cpu_threads = ?'); values.push(validatedThreads); }
    if (cpu_model) { updates.push('cpu_model = ?'); values.push(cpu_model); }
    if (disk_size) { updates.push('disk_size = ?'); values.push(disk_size); }
    if (username) { updates.push('username = ?'); values.push(username); }
    if (password) { updates.push('password = ?'); values.push(password); }
    if (enable_acpi !== undefined) { updates.push('enable_acpi = ?'); values.push(enable_acpi ? 1 : 0); }
    if (enable_kvm !== undefined) { updates.push('enable_kvm = ?'); values.push(enable_kvm ? 1 : 0); }
    if (extra_args !== undefined) { updates.push('extra_args = ?'); values.push(extra_args || ''); }
    if (network_type) { updates.push('network_type = ?'); values.push(network_type); }
    if (ipv4_address !== undefined) { updates.push('ipv4_address = ?'); values.push(ipv4_address); }
    if (ipv4_gateway !== undefined) { updates.push('ipv4_gateway = ?'); values.push(ipv4_gateway); }
    if (ipv4_netmask !== undefined) { updates.push('ipv4_netmask = ?'); values.push(ipv4_netmask); }
    if (dns_primary) { updates.push('dns_primary = ?'); values.push(dns_primary); }
    if (dns_secondary) { updates.push('dns_secondary = ?'); values.push(dns_secondary); }
    if (ipv6_address !== undefined) { updates.push('ipv6_address = ?'); values.push(ipv6_address); }
    if (ipv6_gateway !== undefined) { updates.push('ipv6_gateway = ?'); values.push(ipv6_gateway); }
    if (mac_address) { updates.push('mac_address = ?'); values.push(mac_address); }
    if (vlan_id !== undefined) { updates.push('vlan_id = ?'); values.push(vlan_id); }
    if (custom_cpu_name) { updates.push('custom_cpu_name = ?'); values.push(custom_cpu_name); }
    if (board_name) { updates.push('board_name = ?'); values.push(board_name); }
    if (product_name) { updates.push('product_name = ?'); values.push(product_name); }
    if (machine_type) { updates.push('machine_type = ?'); values.push(machine_type); }
    if (smbios_manufacturer) { updates.push('smbios_manufacturer = ?'); values.push(smbios_manufacturer); }
    if (smbios_product) { updates.push('smbios_product = ?'); values.push(smbios_product); }
    if (smbios_version) { updates.push('smbios_version = ?'); values.push(smbios_version); }
    if (smbios_serial) { updates.push('smbios_serial = ?'); values.push(smbios_serial); }
    
    // Handle SSH port - prefer ssh_port_static if provided, else use ssh_port
    if (ssh_port_static !== undefined) { updates.push('ssh_port_static = ?'); values.push(ssh_port_static); }
    if (ssh_port !== undefined) { updates.push('ssh_port = ?'); values.push(ssh_port); }
    
    // Only admins can change owner
    if (owner_id !== undefined && req.session.role === 'admin') {
      updates.push('owner_id = ?');
      values.push(owner_id || null); // Allow null to clear owner
      console.log(`[VM ${vm_id}] Admin changing owner to ${owner_id || 'null'}`);
    }

    if (updates.length === 0) {
      return res.status(400).json({ error: 'No valid fields to update' });
    }

    values.push(vm_id);
    const query = `UPDATE vms SET ${updates.join(', ')} WHERE vm_id = ?`;

    db.run(query, values, async (err) => {
      if (err) return res.status(500).json({ error: err.message });
      
      try {
        // If username or password changed, regenerate cloud-init seed
        if ((username || password) && vm.template_type === 'cloud-init') {
          console.log(`[VM-${vm_id}] ✓ Username/password changed - regenerating cloud-init seed...`);
          
          db.get(`SELECT * FROM vms WHERE vm_id = ?`, [vm_id], (err, updatedVm) => {
            if (err) {
              console.error(`[VM-${vm_id}] Failed to fetch updated VM for seed regeneration:`, err.message);
              return;
            }
            
            if (!updatedVm) {
              console.error(`[VM-${vm_id}] Updated VM not found in database`);
              return;
            }
            
            console.log(`[VM-${vm_id}] Updated VM - username: ${updatedVm.username}, password: ${updatedVm.password ? '****' : 'not set'}`);
            console.log(`[VM-${vm_id}] Seed file path: ${updatedVm.seed_file}`);
            
            if (!updatedVm.seed_file) {
              console.error(`[VM-${vm_id}] Seed file path not set in database`);
              return;
            }
            
            if (fs.existsSync(updatedVm.seed_file)) {
              // Delete old seed file
              try {
                fs.unlinkSync(updatedVm.seed_file);
                console.log(`[VM-${vm_id}] ✓ Deleted old seed ISO: ${updatedVm.seed_file}`);
              } catch (err) {
                console.error(`[VM-${vm_id}] Failed to delete old seed file:`, err.message);
              }
            } else {
              console.log(`[VM-${vm_id}] Old seed file not found (might be first time): ${updatedVm.seed_file}`);
            }
            
            // Create new seed with updated config
            console.log(`[VM-${vm_id}] Creating new cloud-init seed ISO with updated credentials...`);
            createCloudInitSeed(vm_id, updatedVm)
              .then(() => {
                console.log(`[VM-${vm_id}] ✓ Cloud-init seed regenerated successfully with new username/password`);
                logVMAction(vm_id, 'edit', 'success', `Cloud-init seed regenerated with new credentials. VM will use new username/password on next boot.`);
              })
              .catch(err => {
                console.error(`[VM-${vm_id}] ✗ Failed to regenerate cloud-init seed:`, err.message);
                logVMAction(vm_id, 'edit', 'warning', `VM configuration updated but cloud-init seed regeneration failed: ${err.message}`);
              });
          });
        }
        
        // If disk_size changed, handle disk resize
        if (disk_size) {
          console.log(`[VM-${vm_id}] Disk size changed to ${disk_size} - queuing resize...`);
          
          db.get(`SELECT * FROM vms WHERE vm_id = ?`, [vm_id], (err, updatedVm) => {
            if (!err && updatedVm && updatedVm.disk_file && fs.existsSync(updatedVm.disk_file)) {
              resizeDisk(vm_id, updatedVm.disk_file, disk_size)
                .then(result => {
                  console.log(`[VM-${vm_id}] Disk resize result: ${result.message}`);
                  logVMAction(vm_id, 'edit', 'pending', `VM configuration updated. Disk ${result.message}`);
                })
                .catch(err => {
                  console.error(`[VM-${vm_id}] Disk resize failed:`, err.message);
                  logVMAction(vm_id, 'edit', 'warning', `VM configuration updated. Disk resize failed: ${err.message}`);
                });
            }
          });
        }
      } catch (err) {
        console.error(`[VM-${vm_id}] Post-update processing error:`, err.message);
      }
      
      res.json({ success: true, message: 'VM configuration updated', vm_id });
    });
  });
});

app.get('/api/vms/:vm_id/stats', checkAuth, async (req, res) => {
  try {
    db.get(`SELECT * FROM vms WHERE vm_id = ?`, [req.params.vm_id], async (err, vm) => {
      if (err || !vm) return res.status(404).json({ error: 'VM not found' });

      const stats = {
        vm_id: vm.vm_id,
        vm_name: vm.vm_name,
        status: vm.status,
        memory: vm.memory,
        cpus: vm.cpus,
        disk_size: vm.disk_size,
        uptime: vm.uptime || 0,
        cpu_usage: 0,
        memory_usage: 0,
        disk_usage: 'N/A',
        pid: vmProcesses.get(vm.vm_id) || null
      };

      if (vm.status === 'running' && vmProcesses.has(vm.vm_id)) {
        const pidFile = path.join(VM_DIR, `vm-${vm.vm_id}.pid`);
        try {
          if (fs.existsSync(pidFile)) {
            const pid = parseInt(fs.readFileSync(pidFile, 'utf8').trim());
            const { stdout } = await execPromise(`ps -p ${pid} -o %cpu,%mem,etime 2>nul || echo "0 0 0:00"`, { shell: 'cmd' });
            const lines = stdout.trim().split('\n');
            if (lines.length > 0) {
              const data = lines[0].trim().split(/\s+/);
              stats.cpu_usage = parseFloat(data[0]) || 0;
              stats.memory_usage = parseFloat(data[1]) || 0;
            }
          }
        } catch (e) {
          // Silent fail
        }

        if (fs.existsSync(vm.disk_file)) {
          const size = fs.statSync(vm.disk_file).size / (1024 * 1024 * 1024);
          stats.disk_usage = size.toFixed(2) + ' GB';
        }
      }

      res.json(stats);
    });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// ============================================
// VM REINSTALL ENDPOINT
// ============================================
// POST /api/vms/:vm_id/reinstall
// Owner can reinstall their VM with a different OS template
// Deletes disk and seed ISO but keeps logs
app.post('/api/vms/:vm_id/reinstall', checkAuth, async (req, res) => {
  try {
    const vm_id = req.params.vm_id;
    const { new_os_template, new_username, new_password, confirm } = req.body;
    const userId = req.session.userId;

    if (!confirm) {
      return res.status(400).json({ error: 'Reinstall must be confirmed' });
    }

    if (!new_os_template) {
      return res.status(400).json({ error: 'Please select an OS template' });
    }

    // Get VM
    const getVmQuery = req.session.role === 'admin' 
      ? `SELECT * FROM vms WHERE vm_id = ?`
      : `SELECT * FROM vms WHERE vm_id = ? AND (owner_id = ? OR owner_id IS NULL)`;
    
    const params = req.session.role === 'admin' 
      ? [vm_id]
      : [vm_id, userId];

    db.get(getVmQuery, params, async (err, vm) => {
      if (err || !vm) {
        return res.status(404).json({ error: 'VM not found or access denied' });
      }

      // Only allow reinstall if VM is stopped
      if (vm.status !== 'stopped') {
        return res.status(400).json({ error: 'VM must be stopped to reinstall' });
      }

      console.log(`[VM-${vm_id}] ✓ Starting reinstall with template: ${new_os_template}`);
      console.log(`[VM-${vm_id}] Current status: ${vm.status}`);

      try {
        // Validate new template
        let template = null;
        let isCloudInit = false;
        let templateName = 'Custom OS';
        let username = new_username || 'root';
        let password = new_password || 'password';

        if (OS_TEMPLATES[new_os_template]) {
          // Built-in template
          template = OS_TEMPLATES[new_os_template];
          isCloudInit = true;
          templateName = template.name;
          username = new_username || template.username;
          password = new_password || template.password;
          console.log(`[VM-${vm_id}] Using built-in template: ${templateName}`);
        } else {
          // Check database for custom template
          const customTemplate = await new Promise((resolve, reject) => {
            db.get(`SELECT * FROM os_templates WHERE template_key = ?`, [new_os_template], (err, result) => {
              if (err) reject(err);
              else resolve(result);
            });
          });

          if (!customTemplate) {
            const builtInKeys = Object.keys(OS_TEMPLATES);
            return res.status(400).json({ 
              error: `Invalid OS template: ${new_os_template}. Available: ${builtInKeys.join(', ')}` 
            });
          }

          template = customTemplate;
          isCloudInit = customTemplate.template_type === 'cloud-init';
          templateName = customTemplate.template_name;
          username = new_username || customTemplate.username || 'ubuntu';
          password = new_password || customTemplate.password || 'password';
          console.log(`[VM-${vm_id}] Using custom template: ${templateName}`);
        }

        // Delete old files (but keep logs)
        console.log(`[VM-${vm_id}] Cleaning up old files...`);
        
        if (vm.disk_file && fs.existsSync(vm.disk_file)) {
          try {
            fs.unlinkSync(vm.disk_file);
            console.log(`[VM-${vm_id}] ✓ Deleted disk file: ${vm.disk_file}`);
          } catch (err) {
            console.warn(`[VM-${vm_id}] ⚠ Failed to delete disk file:`, err.message);
          }
        }

        if (vm.seed_file && fs.existsSync(vm.seed_file)) {
          try {
            fs.unlinkSync(vm.seed_file);
            console.log(`[VM-${vm_id}] ✓ Deleted seed ISO: ${vm.seed_file}`);
          } catch (err) {
            console.warn(`[VM-${vm_id}] ⚠ Failed to delete seed ISO:`, err.message);
          }
        }

        // NOTE: Keep log files for audit trail

        // Update VM with new template info and credentials
        db.run(
          `UPDATE vms SET 
            os_type = ?, template_type = ?, username = ?, password = ?,
            img_file = '', seed_file = ?, disk_file = ?
          WHERE vm_id = ?`,
          [templateName, new_os_template, username, password, vm.seed_file, vm.disk_file, vm_id],
          async (err) => {
            if (err) {
              console.error(`[VM-${vm_id}] Failed to update VM info:`, err.message);
              return res.status(500).json({ error: 'Failed to update VM: ' + err.message });
            }

            console.log(`[VM-${vm_id}] ✓ VM info updated - template: ${templateName}, user: ${username}`);

            try {
              // Re-download/setup template if cloud-init
              if (isCloudInit) {
                console.log(`[VM-${vm_id}] Preparing cloud-init template...`);

                db.get(`SELECT * FROM vms WHERE vm_id = ?`, [vm_id], async (err, updatedVm) => {
                  if (err || !updatedVm) {
                    console.error(`[VM-${vm_id}] Failed to fetch updated VM`);
                    return;
                  }

                  try {
                    // Handle template download/copy
                    let imgSourcePath = null;

                    if (OS_TEMPLATES[new_os_template]) {
                      // Built-in template - check cache
                      const cachedTemplateName = `${new_os_template}-template.qcow2`;
                      const cachedTemplatePath = path.join(TEMPLATES_DIR, cachedTemplateName);

                      if (fs.existsSync(cachedTemplatePath)) {
                        console.log(`[VM-${vm_id}] ✓ Using cached template: ${cachedTemplatePath}`);
                        imgSourcePath = cachedTemplatePath;
                      } else {
                        // Download template
                        const downloadUrl = OS_TEMPLATES[new_os_template].url;
                        console.log(`[VM-${vm_id}] Downloading template from: ${downloadUrl}`);
                        
                        await downloadTemplate(new_os_template, cachedTemplatePath);
                        imgSourcePath = cachedTemplatePath;
                        console.log(`[VM-${vm_id}] ✓ Template downloaded and cached`);
                      }
                    } else {
                      // Custom template - use local path
                      const customTemplate = await new Promise((resolve, reject) => {
                        db.get(`SELECT * FROM os_templates WHERE template_key = ?`, [new_os_template], (err, result) => {
                          if (err) reject(err);
                          else resolve(result);
                        });
                      });

                      if (customTemplate && customTemplate.local_path && fs.existsSync(customTemplate.local_path)) {
                        imgSourcePath = customTemplate.local_path;
                        console.log(`[VM-${vm_id}] ✓ Using custom template: ${imgSourcePath}`);
                      }
                    }

                    if (!imgSourcePath) {
                      console.error(`[VM-${vm_id}] Failed to locate template`);
                      logVMAction(vm_id, 'reinstall', 'error', 'Failed to locate OS template');
                      return;
                    }

                    // Create new disk from template
                    console.log(`[VM-${vm_id}] Creating new disk from template...`);
                    const diskSizeVal = updatedVm.disk_size || '20G';
                    
                    try {
                      // Copy template to disk file
                      const copyCommand = process.platform === 'win32'
                        ? `Copy-Item -Path "${imgSourcePath}" -Destination "${updatedVm.disk_file}" -Force`
                        : `cp "${imgSourcePath}" "${updatedVm.disk_file}"`;

                      execSync(copyCommand, { shell: process.platform === 'win32' ? 'powershell' : '/bin/bash' });
                      console.log(`[VM-${vm_id}] ✓ Disk file created`);

                      // Resize disk to specified size
                      const resizeCommand = process.platform === 'win32'
                        ? `qemu-img resize "${updatedVm.disk_file}" ${diskSizeVal}`
                        : `qemu-img resize "${updatedVm.disk_file}" ${diskSizeVal}`;

                      execSync(resizeCommand, { stdio: 'pipe' });
                      console.log(`[VM-${vm_id}] ✓ Disk resized to ${diskSizeVal}`);

                      // Create new cloud-init seed
                      console.log(`[VM-${vm_id}] Creating cloud-init seed with new credentials...`);
                      await createCloudInitSeed(vm_id, updatedVm);
                      console.log(`[VM-${vm_id}] ✓ Cloud-init seed created`);

                      // Log the action
                      logVMAction(vm_id, 'reinstall', 'success', 
                        `VM reinstalled with ${templateName}. Old disk and seed deleted. New credentials: ${username} / ****. VM ready to start.`);

                      res.json({ 
                        success: true, 
                        message: `VM ${vm_id} reinstalled successfully with ${templateName}. Ready to start.`,
                        vm_id 
                      });

                    } catch (err) {
                      console.error(`[VM-${vm_id}] Disk creation failed:`, err.message);
                      logVMAction(vm_id, 'reinstall', 'error', `Disk creation failed: ${err.message}`);
                      res.status(500).json({ error: 'Failed to create disk: ' + err.message });
                    }

                  } catch (err) {
                    console.error(`[VM-${vm_id}] Reinstall failed:`, err.message);
                    logVMAction(vm_id, 'reinstall', 'error', `Reinstall failed: ${err.message}`);
                    res.status(500).json({ error: 'Reinstall failed: ' + err.message });
                  }
                });

              } else {
                // Non-cloud-init template (ISO)
                logVMAction(vm_id, 'reinstall', 'success', `VM configuration updated for ${templateName}. Ready to start.`);
                res.json({ 
                  success: true, 
                  message: `VM updated to ${templateName}. Ready to start.`,
                  vm_id 
                });
              }

            } catch (err) {
              console.error(`[VM-${vm_id}] Post-reinstall processing failed:`, err.message);
              logVMAction(vm_id, 'reinstall', 'error', `Post-reinstall processing failed: ${err.message}`);
              res.status(500).json({ error: 'Post-reinstall processing failed: ' + err.message });
            }
          }
        );

      } catch (err) {
        console.error(`[VM-${vm_id}] Reinstall error:`, err.message);
        logVMAction(vm_id, 'reinstall', 'error', err.message);
        res.status(500).json({ error: 'Reinstall failed: ' + err.message });
      }
    });

  } catch (err) {
    console.error(`Reinstall endpoint error:`, err.message);
    res.status(500).json({ error: err.message });
  }
});

// VM CREATE (Admin only)
app.post('/api/vms', checkAuth, checkAdmin, async (req, res) => {
  const { 
    vm_name, os_template, hostname, custom_memory, custom_cpus,
    iso_file, custom_username, custom_password, disk_size,
    cpu_sockets, cpu_cores, cpu_threads, cpu_model, custom_cpu_name,
    machine_type, board_name, product_name, custom_smbios_manufacturer,
    smbios_manufacturer, smbios_product, smbios_version, smbios_serial,
    enable_acpi, enable_kvm, extra_args,
    network_type, ipv4_address, gateway, netmask,
    dns_servers, ssh_port, ssh_port_static, http_port,
    ipv6_address, ipv6_gateway, mac_address, vlan_id, owner_id
  } = req.body;
  
  // Alias gateway to ipv4_gateway for consistency
  const ipv4_gateway = gateway;
  const ipv4_netmask = netmask;
  // Parse DNS servers - can be comma-separated
  const dns_list = dns_servers ? dns_servers.split(',').map(d => d.trim()) : ['8.8.8.8', '8.8.4.4'];
  const dns_primary = dns_list[0] || '8.8.8.8';
  const dns_secondary = dns_list[1] || '8.8.4.4';
  
  // Either os_template or iso_file must be provided
  if (!os_template && !iso_file) {
    return res.status(400).json({ error: 'Please select a template or upload ISO' });
  }

  let template = null;
  let isCloudInit = false;
  let templateName = 'Custom ISO';
  let username = custom_username || 'root';
  let password = custom_password || 'password';

  if (os_template) {
    // Check if it's a built-in template
    if (OS_TEMPLATES[os_template]) {
      template = OS_TEMPLATES[os_template];
      isCloudInit = true;
      templateName = template.name;
      username = custom_username || template.username;
      password = custom_password || template.password;
    } else {
      // Not built-in, check database for custom template
      const customTemplate = await new Promise((resolve, reject) => {
        db.get(`SELECT * FROM os_templates WHERE template_key = ?`, [os_template], (err, result) => {
          if (err) reject(err);
          else resolve(result);
        });
      });

      if (!customTemplate) {
        const builtInKeys = Object.keys(OS_TEMPLATES);
        console.warn(`[VM Creation] Invalid template key: "${os_template}". Available built-in: ${builtInKeys.join(', ')}`);
        return res.status(400).json({ error: `Invalid OS template: ${os_template}. Please select a valid template.` });
      }

      // Use custom template
      template = customTemplate;
      isCloudInit = customTemplate.template_type === 'cloud-init';
      templateName = customTemplate.template_name;
      username = custom_username || customTemplate.username || 'ubuntu';
      password = custom_password || customTemplate.password || 'password';
      console.log(`[VM Creation] Using custom template: ${templateName} (${os_template})`);
    }
  }

  const memory = custom_memory || (template ? template.memory : 2048);
  const cpuCount = custom_cpus || (template ? template.cpus : 2);
  const sockets = cpu_sockets || 1;
  const cores = cpu_cores || cpuCount;
  const threads = cpu_threads || 1;
  const cpuModelToUse = cpu_model && CPU_MODELS[cpu_model] ? cpu_model : 'host';
  const diskSizeVal = disk_size || (template ? template.disk_size : '20G');
  const netType = network_type || 'dhcp';
  const macAddr = mac_address || generateMACAddress();
  const vmOwner = owner_id || req.session.userId; // Use selected owner if provided, else current user
  
  // Handle SSH port - prefer ssh_port_static if provided, else use ssh_port
  const sshPortVal = ssh_port_static || ssh_port || 22;
  
  // Insert VM first to get vm_id
  db.run(
    `INSERT INTO vms (
      vm_name, os_type, template_type, hostname, username, password, 
      memory, cpus, cpu_sockets, cpu_cores, cpu_threads, cpu_model, custom_cpu_name,
      machine_type, board_name, product_name, custom_smbios_manufacturer,
      disk_size, img_file, seed_file, disk_file,
      status, uptime, node_name,
      smbios_manufacturer, smbios_product, smbios_version, smbios_serial,
      extra_args, enable_acpi, enable_kvm,
      network_type, ipv4_address, ipv4_gateway, ipv4_netmask,
      dns_servers, dns_primary, dns_secondary, ssh_port, ssh_port_static, http_port,
      ipv6_address, ipv6_gateway, mac_address, bridge_interface, vlan_id, owner_id
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [
      vm_name, templateName, os_template || (isCloudInit ? 'cloud-init' : 'iso-installer'), hostname, 
      username, password, memory, cpuCount, sockets, cores, threads, cpuModelToUse, custom_cpu_name || null,
      machine_type || 'pc', board_name || 'Main-Board', product_name || 'Virtual Machine', custom_smbios_manufacturer || 'QEMU',
      diskSizeVal, '', '', '',
      'stopped', 0, 'localhost',
      smbios_manufacturer || 'QEMU', smbios_product || 'KVM Virtual Machine',
      smbios_version || '1.0', smbios_serial || `vm-${Date.now()}`,
      extra_args || '', enable_acpi !== false ? 1 : 0, enable_kvm !== false ? 1 : 0,
      netType, ipv4_address || null, ipv4_gateway || null, ipv4_netmask || '255.255.255.0',
      dns_servers || '8.8.8.8,8.8.4.4', dns_primary || '8.8.8.8', dns_secondary || '8.8.4.4', null, sshPortVal, http_port || 80,
      ipv6_address || null, ipv6_gateway || null,
      macAddr, null, vlan_id || null, vmOwner
    ],
    async function(err) {
      if (err) return res.status(500).json({ error: err.message });
      
      const vm_id = this.lastID;
      // Cloud-init images go to /cloudvm, ISO images go to /iso
      const img_file = isCloudInit 
        ? path.join(CLOUDVM_DIR, `${os_template || 'custom'}-${vm_id}.qcow2`)
        : path.join(ISO_DIR, `${os_template || 'custom'}-${vm_id}.qcow2`);
      const disk_file = path.join(VM_DIR, `vm-${vm_id}-disk.qcow2`);
      const seed_file = path.join(VM_DIR, `vm-${vm_id}-seed.iso`);

      try {
        // Update with file paths
        db.run(
          `UPDATE vms SET img_file = ?, seed_file = ?, disk_file = ? WHERE vm_id = ?`,
          [img_file, seed_file, disk_file, vm_id],
          async (err) => {
            if (err) {
              db.run(`DELETE FROM vms WHERE vm_id = ?`, [vm_id]);
              return res.status(500).json({ error: err.message });
            }

            try {
              // If using cloud-init template, check cache first
              if (os_template && isCloudInit) {
                // Check if it's a built-in or custom template
                let templateSourcePath = null;

                if (OS_TEMPLATES[os_template]) {
                  // Built-in template - use cache in /vms/templates
                  const cachedTemplateName = `${os_template}-template.qcow2`;
                  const cachedTemplatePath = path.join(TEMPLATES_DIR, cachedTemplateName);

                  if (fs.existsSync(cachedTemplatePath)) {
                    console.log(`[VM-${vm_id}] Using cached built-in template from: ${cachedTemplatePath}`);
                    templateSourcePath = cachedTemplatePath;
                  } else {
                    console.log(`[VM-${vm_id}] Cached template not found at ${cachedTemplatePath}`);
                    console.log(`[VM-${vm_id}] Downloading built-in template: ${templateName} to cache...`);
                    
                    // Download to cache first
                    try {
                      await downloadTemplate(os_template, cachedTemplatePath);
                      console.log(`[VM-${vm_id}] ✓ Built-in template cached to: ${cachedTemplatePath}`);
                      templateSourcePath = cachedTemplatePath;
                    } catch (dlErr) {
                      console.error(`[VM-${vm_id}] Template download failed:`, dlErr.message);
                      throw new Error(`Failed to download built-in template: ${dlErr.message}`);
                    }
                  }
                } else {
                  // Custom template - check database for local path
                  const customTemplate = await new Promise((resolve, reject) => {
                    db.get(`SELECT * FROM os_templates WHERE template_key = ?`, [os_template], (err, result) => {
                      if (err) reject(err);
                      else resolve(result);
                    });
                  });

                  if (!customTemplate) {
                    throw new Error(`Custom template "${os_template}" not found in database`);
                  }

                  if (customTemplate.local_path && fs.existsSync(customTemplate.local_path)) {
                    console.log(`[VM-${vm_id}] Using cached custom template from: ${customTemplate.local_path}`);
                    templateSourcePath = customTemplate.local_path;
                  } else if (customTemplate.download_url) {
                    console.log(`[VM-${vm_id}] Custom template not cached, downloading from ${customTemplate.download_url}...`);
                    
                    // Generate local path if not set
                    let localPath = customTemplate.local_path;
                    if (!localPath) {
                      const urlParts = customTemplate.download_url.split('/');
                      const fileName = urlParts[urlParts.length - 1] || `${os_template}-template.qcow2`;
                      localPath = path.join(TEMPLATES_DIR, fileName);
                    }

                    try {
                      // Create templates directory if needed
                      if (!fs.existsSync(TEMPLATES_DIR)) {
                        fs.mkdirSync(TEMPLATES_DIR, { recursive: true });
                      }

                      await downloadTemplateFromURL(customTemplate.download_url, localPath);
                      console.log(`[VM-${vm_id}] ✓ Custom template downloaded to: ${localPath}`);
                      
                      // Update database with local path
                      await new Promise((resolve, reject) => {
                        db.run(`UPDATE os_templates SET local_path = ? WHERE template_key = ?`,
                          [localPath, os_template],
                          (err) => {
                            if (err) {
                              console.error('Failed to update template path in DB:', err);
                              reject(err);
                            } else {
                              resolve();
                            }
                          }
                        );
                      });

                      templateSourcePath = localPath;
                    } catch (dlErr) {
                      console.error(`[VM-${vm_id}] Custom template download failed:`, dlErr.message);
                      throw new Error(`Failed to download custom template: ${dlErr.message}`);
                    }
                  } else {
                    throw new Error(`Custom template "${os_template}" has no local path or download URL`);
                  }
                }

                // Copy template to VM's image file
                if (templateSourcePath) {
                  try {
                    const copyCmd = process.platform === 'win32' 
                      ? `copy "${templateSourcePath}" "${img_file}"`
                      : `cp "${templateSourcePath}" "${img_file}"`;
                    
                    console.log(`[VM-${vm_id}] Copying template to: ${img_file}`);
                    await execPromise(copyCmd, { 
                      shell: process.platform === 'win32' ? 'cmd' : '/bin/bash',
                      stdio: 'pipe'
                    });
                    console.log(`[VM-${vm_id}] ✓ Copied template to ${img_file}`);
                  } catch (copyErr) {
                    console.error(`[VM-${vm_id}] Failed to copy template:`, copyErr.message);
                    throw new Error(`Failed to copy template: ${copyErr.message}`);
                  }
                }
              }

              // Create cloud-init seed if cloud-init type
              if (isCloudInit) {
                const vmData = {
                  vm_id,
                  vm_name,
                  hostname,
                  username,
                  password,
                  network_type: netType,
                  ipv4_address: ipv4_address || null,
                  ipv4_gateway: ipv4_gateway || null,
                  ipv4_netmask: ipv4_netmask || '255.255.255.0',
                  dns_primary: dns_primary || '8.8.8.8',
                  dns_secondary: dns_secondary || '8.8.4.4',
                  ipv6_address: ipv6_address || null,
                  ipv6_gateway: ipv6_gateway || null
                };
                await createCloudInitSeed(vm_id, vmData);
                
                // Create disk from template with resize to specified size
                console.log(`[VM-${vm_id}] Creating and resizing disk to ${diskSizeVal}...`);
                try {
                  // Copy template to disk file and resize in one step
                  const resizeDiskCmd = `qemu-img convert -O qcow2 "${img_file}" "${disk_file}" && qemu-img resize "${disk_file}" ${diskSizeVal}`;
                  await execPromise(resizeDiskCmd, { 
                    shell: isWindows ? 'cmd' : '/bin/bash',
                    stdio: 'pipe'
                  });
                  
                  console.log(`[VM-${vm_id}] ✓ Disk created and resized to: ${diskSizeVal}`);
                } catch (diskError) {
                  logError('DISK', vm_id, 'creation', diskError);
                  throw new Error(`Disk creation failed: ${diskError.message}`);
                }
              } else {
                // ISO mode: Create a new disk from scratch with specified size
                console.log(`[VM-${vm_id}] Creating disk: ${disk_file} (size: ${diskSizeVal})`);
                try {
                  const createDiskCmd = `qemu-img create -f qcow2 "${disk_file}" ${diskSizeVal}`;
                  
                  await execPromise(createDiskCmd, { 
                    shell: isWindows ? 'cmd' : '/bin/bash',
                    stdio: 'pipe'
                  });
                  console.log(`[VM-${vm_id}] ✓ Disk created: ${diskSizeVal}`);
                } catch (diskError) {
                  logError('DISK', vm_id, 'creation', diskError);
                  throw new Error(`Disk creation failed: ${diskError.message}`);
                }
              }

              logVMAction(vm_id, 'create', 'pending', `VM ${vm_name} (ID:${vm_id}) created from ${templateName}`);
              res.json({ 
                success: true, 
                vm_id: vm_id, 
                template: isCloudInit ? 'cloud-init' : 'iso-installer',
                config: {
                  cpus: cpuCount,
                  sockets: sockets,
                  cores: cores,
                  threads: threads,
                  cpu_model: cpuModelToUse,
                  memory: memory,
                  disk_size: diskSizeVal,
                  network_type: netType,
                  mac_address: macAddr,
                  ipv4: ipv4_address || 'DHCP',
                  gateway: ipv4_gateway || 'DHCP'
                }
              });
            } catch (downloadError) {
              logError('TEMPLATE', vm_id, 'download', downloadError);
              // Clean up partial files
              if (fs.existsSync(img_file)) {
                try { fs.unlinkSync(img_file); } catch (e) {}
              }
              db.run(`DELETE FROM vms WHERE vm_id = ?`, [vm_id]);
              return res.status(500).json({ error: `Failed to download template: ${downloadError.message}` });
            }
          }
        );
      } catch (error) {
        logError('VM', vm_id, 'creation', error);
        db.run(`DELETE FROM vms WHERE vm_id = ?`, [vm_id]);
        res.status(500).json({ error: error.message });
      }
    }
  );
});

// VM START (Using VM ID)
app.post('/api/vms/:vm_id/start', checkAuth, async (req, res) => {
  try {
    const userId = req.session.userId;
    let query = `SELECT * FROM vms WHERE vm_id = ?`;
    let params = [req.params.vm_id];
    
    // Normal users can only start their own VMs
    if (req.session.role !== 'admin') {
      query += ` AND owner_id = ?`;
      params.push(userId);
    }
    
    db.get(query, params, async (err, vm) => {
      if (err || !vm) {
        console.error(`[API Error] /api/vms/${req.params.vm_id}/start: VM not found or access denied`);
        return res.status(404).json({ error: 'VM not found or access denied' });
      }

      if (vm.status === 'running') {
        console.log(`[API] VM ${vm.vm_id} already running`);
        return res.json({ success: true, message: `VM ${vm.vm_name} is already running` });
      }

      try {
        console.log(`[API] Starting VM ${vm.vm_id} (${vm.vm_name}) by user ${userId}`);
        const result = await startQemuVM(vm);
        if (result.success) {
          vmProcesses.set(vm.vm_id, result.pid);
          db.run(`UPDATE vms SET status = 'running', uptime = 0 WHERE vm_id = ?`, [vm.vm_id]);
          logVMAction(vm.vm_id, 'start', 'running', `VM started successfully`);
          console.log(`[API Success] VM ${vm.vm_id} started successfully`);
          res.json({ success: true, message: `VM ${vm.vm_name} (ID:${vm.vm_id}) started`, vm_id: vm.vm_id });
        } else {
          console.error(`[API Error] Failed to start VM ${vm.vm_id}`);
          res.status(500).json({ error: 'Failed to start VM' });
        }
      } catch (error) {
        console.error(`[API Error] Exception starting VM ${vm.vm_id}:`, error);
        logVMAction(vm.vm_id, 'start', 'failed', error.message);
        res.status(500).json({ error: error.message });
      }
    });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// VM STOP (Using VM ID)
app.post('/api/vms/:vm_id/stop', checkAuth, (req, res) => {
  const userId = req.session.userId;
  let query = `SELECT * FROM vms WHERE vm_id = ?`;
  let params = [req.params.vm_id];
  
  // Normal users can only stop their own VMs
  if (req.session.role !== 'admin') {
    query += ` AND owner_id = ?`;
    params.push(userId);
  }
  
  db.get(query, params, (err, vm) => {
    if (err || !vm) {
      console.error(`[API Error] /api/vms/${req.params.vm_id}/stop: VM not found or access denied`);
      return res.status(404).json({ error: 'VM not found or access denied' });
    }

    if (vm.status === 'stopped') {
      console.log(`[API] VM ${vm.vm_id} already stopped`);
      return res.json({ success: true, message: 'VM already stopped' });
    }

    try {
      console.log(`[API] Stopping VM ${vm.vm_id} (${vm.vm_name}) by user ${userId}`);
      const pidFile = path.join(VM_DIR, `vm-${vm.vm_id}.pid`);
      if (fs.existsSync(pidFile)) {
        const pid = parseInt(fs.readFileSync(pidFile, 'utf8').trim());
        try {
          // On Windows, use taskkill; on Unix, use process group kill
          if (isWindows) {
            exec(`taskkill /F /PID ${pid}`, { shell: 'cmd' });
          } else {
            // Kill entire process group (- prefix means pgid)
            process.kill(-pid, 'SIGTERM');
            setTimeout(() => {
              try {
                process.kill(-pid, 'SIGKILL');
              } catch (e) {}
            }, 3000);
          }
        } catch (e) {
          // Process may already be dead
        }
      }

      vmProcesses.delete(vm.vm_id);
      db.run(`UPDATE vms SET status = 'stopped' WHERE vm_id = ?`, [vm.vm_id]);
      logVMAction(vm.vm_id, 'stop', 'stopped', `VM stopped`);
      console.log(`[API Success] VM ${vm.vm_id} stopped successfully`);
      res.json({ success: true, message: `VM ${vm.vm_name} (ID:${vm.vm_id}) stopped` });
    } catch (error) {
      console.error(`[API Error] Exception stopping VM ${vm.vm_id}:`, error);
      res.status(500).json({ error: error.message });
    }
  });
});

// VM RESTART (Using VM ID)
app.post('/api/vms/:vm_id/restart', checkAuth, async (req, res) => {
  try {
    const userId = req.session.userId;
    let query = `SELECT * FROM vms WHERE vm_id = ?`;
    let params = [req.params.vm_id];
    
    // Normal users can only restart their own VMs
    if (req.session.role !== 'admin') {
      query += ` AND owner_id = ?`;
      params.push(userId);
    }
    
    db.get(query, params, async (err, vm) => {
      if (err || !vm) return res.status(404).json({ error: 'VM not found or access denied' });

      try {
        const pidFile = path.join(VM_DIR, `vm-${vm.vm_id}.pid`);
        if (fs.existsSync(pidFile)) {
          const pid = parseInt(fs.readFileSync(pidFile, 'utf8').trim());
          try {
            process.kill(pid, 'SIGTERM');
          } catch (e) {}
        }
        
        await new Promise(resolve => setTimeout(resolve, 2000));

        const result = await startQemuVM(vm);
        if (result.success) {
          vmProcesses.set(vm.vm_id, result.pid);
          db.run(`UPDATE vms SET status = 'running' WHERE vm_id = ?`, [vm.vm_id]);
          logVMAction(vm.vm_id, 'restart', 'running', `VM restarted successfully`);
          res.json({ success: true, message: `VM ${vm.vm_name} (ID:${vm.vm_id}) restarted` });
        } else {
          res.status(500).json({ error: 'Failed to restart VM' });
        }
      } catch (error) {
        res.status(500).json({ error: error.message });
      }
    });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// VM REINSTALL (Using VM ID)

// VM DELETE (Using VM ID)
app.delete('/api/vms/:vm_id', checkAuth, (req, res) => {
  db.get(`SELECT * FROM vms WHERE vm_id = ?`, [req.params.vm_id], (err, vm) => {
    if (err || !vm) return res.status(404).json({ error: 'VM not found' });

    try {
      const pidFile = path.join(VM_DIR, `vm-${vm.vm_id}.pid`);
      if (fs.existsSync(pidFile)) {
        const pid = parseInt(fs.readFileSync(pidFile, 'utf8').trim());
        try {
          process.kill(pid, 'SIGKILL');
        } catch (e) {}
      }

      if (fs.existsSync(vm.img_file)) fs.unlinkSync(vm.img_file);
      if (fs.existsSync(vm.seed_file)) fs.unlinkSync(vm.seed_file);
      if (fs.existsSync(vm.disk_file)) fs.unlinkSync(vm.disk_file);

      vmProcesses.delete(vm.vm_id);
      db.run(`DELETE FROM vms WHERE vm_id = ?`, [vm.vm_id]);
      db.run(`DELETE FROM vm_logs WHERE vm_id = ?`, [vm.vm_id]);
      
      logVMAction(vm.vm_id, 'delete', 'deleted', `VM ${vm.vm_name} deleted`);
      res.json({ success: true, message: `VM ${vm.vm_name} (ID:${vm.vm_id}) deleted` });
    } catch (error) {
      res.status(500).json({ error: error.message });
    }
  });
});

// VM LOGS (Using VM ID)
app.get('/api/vms/:vm_id/logs', checkAuth, (req, res) => {
  db.all(
    `SELECT * FROM vm_logs WHERE vm_id = ? ORDER BY timestamp DESC LIMIT 50`,
    [req.params.vm_id],
    (err, logs) => {
      if (err) return res.status(500).json({ error: err.message });
      res.json(logs || []);
    }
  );
});

// VM SNAPSHOTS (Using VM ID)
app.get('/api/vms/:vm_id/snapshots', checkAuth, (req, res) => {
  const userId = req.session.userId;
  let query = `SELECT * FROM vm_snapshots WHERE vm_id = ?`;
  let params = [req.params.vm_id];
  
  // First check ownership if not admin
  if (req.session.role !== 'admin') {
    // Check if user owns this VM
    db.get(`SELECT * FROM vms WHERE vm_id = ? AND owner_id = ?`, [req.params.vm_id, userId], (err, vm) => {
      if (err || !vm) return res.status(404).json({ error: 'VM not found or access denied' });
      
      db.all(query, params, (err, snapshots) => {
        if (err) return res.status(500).json({ error: err.message });
        res.json(snapshots || []);
      });
    });
  } else {
    db.all(query, params, (err, snapshots) => {
      if (err) return res.status(500).json({ error: err.message });
      res.json(snapshots || []);
    });
  }
});

// ============= ISO ATTACH/DETACH ENDPOINTS =============

// Attach ISO to VM (for ISO templates or manual ISO installation)
app.post('/api/vms/:vm_id/iso/attach', checkAuth, async (req, res) => {
  try {
    const vm_id = req.params.vm_id;
    const { iso_file } = req.body;
    const userId = req.session.userId;

    if (!iso_file) {
      return res.status(400).json({ error: 'ISO file is required' });
    }

    // Get VM
    let query = `SELECT * FROM vms WHERE vm_id = ?`;
    let params = [vm_id];

    if (req.session.role !== 'admin') {
      query += ` AND owner_id = ?`;
      params.push(userId);
    }

    db.get(query, params, (err, vm) => {
      if (err || !vm) {
        return res.status(404).json({ error: 'VM not found or access denied' });
      }

      // Verify ISO file exists
      const isoPath = path.join(ISO_DIR, iso_file);
      if (!fs.existsSync(isoPath)) {
        return res.status(400).json({ error: 'ISO file not found' });
      }

      // Update VM with attached ISO
      db.run(
        `UPDATE vms SET iso_attached = ?, boot_from_iso = 1 WHERE vm_id = ?`,
        [iso_file, vm_id],
        (err) => {
          if (err) {
            return res.status(500).json({ error: err.message });
          }

          logVMAction(vm_id, 'iso_attach', 'completed', `ISO file attached: ${iso_file}`);
          res.json({ success: true, message: `ISO file "${iso_file}" attached successfully` });
        }
      );
    });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// Detach ISO from VM
app.post('/api/vms/:vm_id/iso/detach', checkAuth, async (req, res) => {
  try {
    const vm_id = req.params.vm_id;
    const userId = req.session.userId;

    // Get VM
    let query = `SELECT * FROM vms WHERE vm_id = ?`;
    let params = [vm_id];

    if (req.session.role !== 'admin') {
      query += ` AND owner_id = ?`;
      params.push(userId);
    }

    db.get(query, params, (err, vm) => {
      if (err || !vm) {
        return res.status(404).json({ error: 'VM not found or access denied' });
      }

      // Update VM to remove attached ISO and boot from disk
      db.run(
        `UPDATE vms SET iso_attached = NULL, boot_from_iso = 0 WHERE vm_id = ?`,
        [vm_id],
        (err) => {
          if (err) {
            return res.status(500).json({ error: err.message });
          }

          logVMAction(vm_id, 'iso_detach', 'completed', 'ISO file detached, will boot from disk');
          res.json({ success: true, message: 'ISO file detached successfully' });
        }
      );
    });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// Get VM ISO status
app.get('/api/vms/:vm_id/iso/status', checkAuth, async (req, res) => {
  try {
    const vm_id = req.params.vm_id;
    const userId = req.session.userId;

    let query = `SELECT vm_id, iso_attached, boot_from_iso, status FROM vms WHERE vm_id = ?`;
    let params = [vm_id];

    if (req.session.role !== 'admin') {
      query += ` AND owner_id = ?`;
      params.push(userId);
    }

    db.get(query, params, (err, vm) => {
      if (err || !vm) {
        return res.status(404).json({ error: 'VM not found or access denied' });
      }

      res.json({
        vm_id: vm.vm_id,
        iso_attached: vm.iso_attached || null,
        boot_from_iso: vm.boot_from_iso ? true : false,
        vm_status: vm.status
      });
    });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

app.post('/api/vms/:vm_id/snapshots', checkAuth, (req, res) => {
  const userId = req.session.userId;
  const { snapshot_name, description } = req.body;
  
  let query = `SELECT * FROM vms WHERE vm_id = ?`;
  let params = [req.params.vm_id];
  
  // Normal users can only create snapshots for their own VMs
  if (req.session.role !== 'admin') {
    query += ` AND owner_id = ?`;
    params.push(userId);
  }
  
  db.get(query, params, (err, vm) => {
    if (err || !vm) return res.status(404).json({ error: 'VM not found or access denied' });
    
    db.run(
      `INSERT INTO vm_snapshots (vm_id, snapshot_name, size_gb, description) VALUES (?, ?, 0, ?)`,
      [req.params.vm_id, snapshot_name, description],
      function(err) {
        if (err) return res.status(500).json({ error: err.message });
        logVMAction(req.params.vm_id, 'snapshot', 'completed', `Snapshot ${snapshot_name} created`);
        res.json({ success: true, snapshot_id: this.lastID });
      }
    );
  });
});

// ADMIN DASHBOARD
app.get('/api/admin/dashboard', checkAuth, checkAdmin, (req, res) => {
  db.all(`SELECT COUNT(*) as total FROM users`, (err, userCount) => {
    db.all(`SELECT COUNT(*) as total FROM vms`, (err, vmCount) => {
      db.all(`SELECT COUNT(*) as total FROM vms WHERE status = 'running'`, (err, runningCount) => {
        res.json({
          totalUsers: userCount ? userCount[0].total : 0,
          totalVMs: vmCount ? vmCount[0].total : 0,
          runningVMs: runningCount ? runningCount[0].total : 0
        });
      });
    });
  });
});

// HELPER FUNCTIONS

function logVMAction(vm_id, action, status, message) {
  db.run(
    `INSERT INTO vm_logs (vm_id, action, status, message) VALUES (?, ?, ?, ?)`,
    [vm_id, action, status, message]
  );
}

// Download OS template image
// Download template from URL with redirect support
async function downloadTemplateFromURL(url, targetPath) {
  return new Promise((resolve, reject) => {
    console.log(`[TEMPLATE] Downloading from URL: ${url}`);

    const file = fs.createWriteStream(targetPath);
    const https = url.startsWith('https') ? require('https') : require('http');
    
    const makeRequest = (currentUrl, redirectCount = 0) => {
      // Limit redirects to prevent infinite loops
      if (redirectCount > 5) {
        fs.unlink(targetPath, () => {});
        return reject(new Error('Too many redirects'));
      }

      https.get(currentUrl, (response) => {
        // Handle redirects (301, 302, 303, 307, 308)
        if ([301, 302, 303, 307, 308].includes(response.statusCode)) {
          const redirectUrl = response.headers.location;
          if (!redirectUrl) {
            fs.unlink(targetPath, () => {});
            return reject(new Error(`Redirect without location header`));
          }
          console.log(`[TEMPLATE] Redirect (${response.statusCode}) to: ${redirectUrl}`);
          return makeRequest(redirectUrl, redirectCount + 1);
        }

        if (response.statusCode !== 200) {
          fs.unlink(targetPath, () => {});
          return reject(new Error(`HTTP ${response.statusCode}: ${response.statusMessage}`));
        }

        const len = parseInt(response.headers['content-length'], 10);
        let downloaded = 0;

        response.on('data', (chunk) => {
          downloaded += chunk.length;
          if (len) {
            const percent = ((downloaded / len) * 100).toFixed(2);
            console.log(`[TEMPLATE] Download progress: ${percent}%`);
          }
        });

        response.pipe(file);
        file.on('finish', () => {
          file.close();
          console.log(`[TEMPLATE] Downloaded successfully`);
          resolve(true);
        });
        file.on('error', (err) => {
          fs.unlink(targetPath, () => {});
          reject(err);
        });
      }).on('error', (err) => {
        fs.unlink(targetPath, () => {});
        reject(err);
      });
    };

    makeRequest(url);
  });
}

// Download OS template from built-in templates OR directly from URL
async function downloadTemplate(sourceOrKey, targetPath) {
  return new Promise(async (resolve, reject) => {
    try {
      let url;
      let templateName;

      // Check if it's a template key or a direct URL
      if (OS_TEMPLATES[sourceOrKey]) {
        const template = OS_TEMPLATES[sourceOrKey];
        url = template.url;
        templateName = template.name;
      } else if (sourceOrKey.startsWith('http')) {
        // It's a direct URL
        url = sourceOrKey;
        templateName = 'custom template';
      } else {
        return reject(new Error('Invalid template key or URL'));
      }

      console.log(`[TEMPLATE] Downloading ${templateName} from ${url}...`);

      await downloadTemplateFromURL(url, targetPath);
      console.log(`[TEMPLATE] Download complete for ${templateName}`);
      resolve(true);
    } catch (err) {
      reject(err);
    }
  });
}

// Generate Cloud-Init config
/**
 * Generate Cloud-Init v2 Configuration with Netplan
 * Properly handles:
 * - Netplan v2 network configuration
 * - SSH daemon startup with network dependency
 * - Custom username and password
 * - Schema validation
 * - Skip network-wait-online targets
 */
function generateCloudInitConfig(vm) {
  // Escape special characters in password for YAML
  const escapeYaml = (str) => {
    if (!str) return '';
    // If contains special chars, wrap in quotes
    if (/[:\[\]!&*#?|<>=@`{}",\n]/.test(str)) {
      return `'${str.replace(/'/g, "''")}'`;
    }
    return str;
  };

  // Generate password hash for cloud-init
  // Using mkpasswd format or plain password for compatibility
  const generatePasswordHash = (password) => {
    // For simplicity, we'll use plain password with crypt format marker
    // Cloud-init will handle it properly with chpasswd
    return password;
  };

  const username = vm.username || 'root';
  const password = vm.password || 'password';
  const hostname = vm.hostname || 'hkvm-instance';

  // Ensure YAML-safe values
  const safeUsername = escapeYaml(username);
  const safePassword = escapeYaml(password);
  const safeHostname = escapeYaml(hostname);
  const passwordHash = generatePasswordHash(password);

  // If username is 'root', use only root user config
  // Otherwise, create custom user
  const isRootUser = username.toLowerCase() === 'root';
  
  const usersConfig = isRootUser 
    ? `users:
  - name: root
    lock_passwd: false
    shell: /bin/bash`
    : `users:
  - default
  - name: ${safeUsername}
    gecos: ${safeUsername}
    groups:
      - sudo
      - adm
    sudo:
      - "ALL=(ALL) NOPASSWD:ALL"
    shell: /bin/bash
    lock_passwd: false
    passwd: ${safePassword}`;

  const chpasswdConfig = `chpasswd:
  expire: false
  list:
    - root:${safePassword}${isRootUser ? '' : `\n    - ${safeUsername}:${safePassword}`}`;

  const config = `#cloud-config

# ==========================================
# Basic System
# ==========================================
hostname: ${safeHostname}
manage_etc_hosts: true
preserve_hostname: false
timezone: Asia/Kolkata
locale: en_US.UTF-8

# ==========================================
# Users
# ==========================================
${usersConfig}

# ==========================================
# Root Access
# ==========================================
disable_root: false

# ==========================================
# SSH
# ==========================================
ssh_pwauth: true
ssh_deletekeys: false
ssh_genkeytypes:
  - rsa
  - ecdsa
  - ed25519

# ==========================================
# Password
# ==========================================
${chpasswdConfig}

# ==========================================

# Boot Commands - Mask problematic services

# ==========================================

bootcmd:

  - [ systemctl, mask, systemd-networkd-wait-online.service ]

  - [ systemctl, mask, systemd-resolved-wait-online.service ]

# ==========================================

# Write Files - systemd-networkd configuration and SSH config

# ==========================================

write_files:

  - path: /etc/systemd/network/99-dhcp.network

    owner: root:root

    permissions: '0644'

    content: |

      [Match]

      Name=eth*

      Name=ens*

      Name=enp*

      [Network]

      DHCP=yes

      [DHCP]

      ClientIdentifier=mac

  - path: /etc/ssh/sshd_config.d/99-root-login.conf

    owner: root:root

    permissions: '0644'

    content: |

      # Allow root login and password authentication

      PermitRootLogin yes

      PasswordAuthentication yes

      PubkeyAuthentication yes

      UsePAM yes

# ==========================================

# Package Management

# ==========================================

package_update: true

package_upgrade: false

packages:

  - curl

  - wget

  - sudo

  - vim

  - nano

  - htop

  - net-tools

  - iproute2

  - iputils-ping

  - ca-certificates

# ==========================================

# Services - runcmd

# ==========================================

runcmd:

  # Wait and restart networking

  - [ sleep, 2 ]

  - [ systemctl, restart, systemd-networkd ]

  - [ sleep, 2 ]

  # Verify network is up

  - [ ip, link, show ]

  - [ ip, addr, show ]

  # Enable and restart SSH with new config

  - [ systemctl, daemon-reload ]

  - [ systemctl, enable, ssh ]

  - [ systemctl, restart, ssh ]

  - [ systemctl, is-active, ssh ]

  # Set hostname

  - [ hostnamectl, set-hostname, "${safeHostname}" ]

  # Configure user SSH directories (skip if root)

  - /bin/bash -c "if [ '${safeUsername}' != 'root' ]; then mkdir -p /home/${safeUsername}/.ssh && chmod 700 /home/${safeUsername}/.ssh && chown -R ${safeUsername}:${safeUsername} /home/${safeUsername}/.ssh && chmod 755 /home/${safeUsername} && chown -R ${safeUsername}:${safeUsername} /home/${safeUsername}; fi"

  # Final SSH restart

  - [ systemctl, restart, ssh ]

# ==========================================

# Final Message

# ==========================================

final_message: |

  ==========================================

  Cloud-Init Setup Completed

  ==========================================

  Hostname: ${safeHostname}

  Username: ${safeUsername}

  SSH Password Login: Enabled

  Network: DHCP (auto-configured)

  ==========================================
`;

  return config;
}

// Convert netmask to CIDR notation
function maskToCIDR(mask) {
  const parts = mask.split('.');
  let bits = 0;
  for (let i = 0; i < 4; i++) {
    const octet = parseInt(parts[i]);
    for (let j = 7; j >= 0; j--) {
      bits += (octet >> j) & 1;
    }
  }
  return bits;
}

// Simple password for cloud-init (plain text, no hashing)
function getPassword(password) {
  return password;
}

// Generate random MAC address
function generateMACAddress() {
  return 'fa:16:3e:' + [0, 1, 2].map(() => {
    return Math.floor(Math.random() * 256).toString(16).padStart(2, '0');
  }).join(':');
}

/**
 * Create Cloud-Init seed ISO with proper netplan v2 configuration
 * Includes meta-data, user-data, and network-config in correct format
 * Validates YAML syntax before creating ISO
 */
async function createCloudInitSeed(vm_id, vm) {
  return new Promise((resolve, reject) => {
    try {
      const seedDir = path.join(VM_DIR, `vm-${vm_id}-seed-dir`);
      const seedIso = path.join(VM_DIR, `vm-${vm_id}-seed.iso`);
      const metaDataFile = path.join(seedDir, 'meta-data');
      const userDataFile = path.join(seedDir, 'user-data');
      const networkConfigFile = path.join(seedDir, 'network-config');

      // Clean up and create seed directory
      if (fs.existsSync(seedDir)) {
        fs.rmSync(seedDir, { recursive: true, force: true });
      }
      fs.mkdirSync(seedDir, { recursive: true });

      // Meta-data (instance information)
      const metaData = `instance-id: vm-${vm_id}
local-hostname: ${vm.hostname}
`;

      // Network config (v2 format for cloud-init with netplan)
      // This ensures proper DHCP configuration on any interface name
      const networkConfig = `version: 2
renderer: networkd
ethernets:
  any-interface:
    match:
      name: "eth*"
    dhcp4: true
    optional: true
    dhcp-identifier: mac
    dhcp4-overrides:
      route-metric: 100
  ens-interface:
    match:
      name: "ens*"
    dhcp4: true
    optional: true
    dhcp-identifier: mac
    dhcp4-overrides:
      route-metric: 200
  enp-interface:
    match:
      name: "enp*"
    dhcp4: true
    optional: true
    dhcp-identifier: mac
    dhcp4-overrides:
      route-metric: 300
`;

      // User-data (cloud-init configuration)
      const userData = generateCloudInitConfig(vm);

      // Validate cloud-init YAML before writing
      console.log(`[CLOUDINIT-${vm_id}] Validating cloud-init configuration...`);
      
      // Basic YAML validation - check for common issues
      const validateCloudInitConfig = (config) => {
        const errors = [];
        
        // Check if it starts with #cloud-config
        if (!config.startsWith('#cloud-config')) {
          errors.push('Must start with #cloud-config');
        }
        
        // Check for proper indentation (2 spaces)
        const lines = config.split('\n');
        for (let i = 0; i < lines.length; i++) {
          const line = lines[i];
          // Check tab characters (bad in YAML)
          if (line.includes('\t')) {
            errors.push(`Line ${i + 1}: Contains tab character (use spaces instead)`);
          }
          // Check indentation is multiple of 2
          const indent = line.match(/^ */)[0].length;
          if (indent > 0 && indent % 2 !== 0) {
            errors.push(`Line ${i + 1}: Invalid indentation (must be multiple of 2)`);
          }
        }
        
        return errors;
      };
      
      const validationErrors = validateCloudInitConfig(userData);
      if (validationErrors.length > 0) {
        console.warn(`[CLOUDINIT-${vm_id}] ⚠ Configuration warnings:`);
        validationErrors.forEach(err => console.warn(`  - ${err}`));
      } else {
        console.log(`[CLOUDINIT-${vm_id}] ✓ Cloud-init configuration is valid`);
      }

      // Write configuration files
      fs.writeFileSync(metaDataFile, metaData, 'utf8');
      fs.writeFileSync(userDataFile, userData, 'utf8');
      fs.writeFileSync(networkConfigFile, networkConfig, 'utf8');

      console.log(`[CLOUDINIT-${vm_id}] ✓ Configuration files written`);
      console.log(`[CLOUDINIT-${vm_id}] - meta-data: ${(metaData.length / 1024).toFixed(2)}KB`);
      console.log(`[CLOUDINIT-${vm_id}] - user-data: ${(userData.length / 1024).toFixed(2)}KB`);
      console.log(`[CLOUDINIT-${vm_id}] - network-config: ${(networkConfig.length / 1024).toFixed(2)}KB`);

      // Create ISO from seed files
      // Use platform-appropriate tool
      let isoCommand;
      try {
        if (isWindows) {
          // On Windows, try mkisofs first, fall back to cloud-localds
          try {
            isoCommand = `mkisofs -output "${seedIso}" -volid cidata -joliet -rock "${seedDir}"`;
            execSync(isoCommand, { stdio: 'pipe', shell: 'cmd' });
          } catch (e) {
            // Try cloud-localds if available
            console.log(`[CLOUDINIT-${vm_id}] mkisofs not found, trying cloud-localds...`);
            isoCommand = `cloud-localds "${seedIso}" "${userDataFile}" "${metaDataFile}"`;
            execSync(isoCommand, { stdio: 'pipe', shell: 'cmd' });
          }
        } else {
          // On Linux, prefer genisoimage or mkisofs
          try {
            isoCommand = `genisoimage -output "${seedIso}" -volid cidata -joliet -rock "${seedDir}"`;
            execSync(isoCommand, { stdio: 'pipe', shell: '/bin/bash' });
          } catch (e) {
            try {
              isoCommand = `mkisofs -output "${seedIso}" -volid cidata -joliet -rock "${seedDir}"`;
              execSync(isoCommand, { stdio: 'pipe', shell: '/bin/bash' });
            } catch (e2) {
              // Fall back to cloud-localds
              console.log(`[CLOUDINIT-${vm_id}] genisoimage/mkisofs not found, trying cloud-localds...`);
              isoCommand = `cloud-localds "${seedIso}" "${userDataFile}" "${metaDataFile}"`;
              execSync(isoCommand, { stdio: 'pipe', shell: '/bin/bash' });
            }
          }
        }
        
        console.log(`[CLOUDINIT-${vm_id}] ✓ ISO seed created: ${seedIso}`);
        
        // Verify ISO was created
        if (fs.existsSync(seedIso)) {
          const size = fs.statSync(seedIso).size;
          console.log(`[CLOUDINIT-${vm_id}] ✓ ISO size: ${(size / 1024).toFixed(2)}KB`);
          
          // Clean up seed directory after successful ISO creation
          try {
            fs.rmSync(seedDir, { recursive: true, force: true });
            console.log(`[CLOUDINIT-${vm_id}] ✓ Seed directory cleaned up`);
          } catch (e) {
            console.warn(`[CLOUDINIT-${vm_id}] ⚠ Could not clean seed directory`);
          }
          
          resolve(true);
        } else {
          throw new Error('ISO file not created');
        }
      } catch (isoError) {
        console.error(`[CLOUDINIT-${vm_id}] ✗ ISO creation failed: ${isoError.message}`);
        console.error(`[CLOUDINIT-${vm_id}] Please install: genisoimage, mkisofs, or cloud-utils`);
        logError('CLOUDINIT', vm_id, 'ISO creation', isoError);
        reject(new Error('ISO creation tool not available - install genisoimage, mkisofs, or cloud-utils'));
      }
    } catch (error) {
      console.error(`[CLOUDINIT-${vm_id}] Error: ${error.message}`);
      console.error(`[CLOUDINIT-${vm_id}] Stack: ${error.stack}`);
      reject(error);
    }
  });
}

async function startQemuVM(vm) {
  return new Promise((resolve, reject) => {
    try {
      const pidFile = path.join(VM_DIR, `vm-${vm.vm_id}.pid`);
      const logFile = path.join(VM_DIR, `vm-${vm.vm_id}.log`);
      
      // Validate CPU model - fallback to 'host' if model not available
      let cpuToUse = 'host';
      if (vm.custom_cpu_name) {
        // Custom CPU name + CPU model - use both for full flexibility
        // Format: -cpu <cpu_model>,model-id=Custom Name
        // Note: No quotes needed when using spawn() array format
        let baseCpuModel = 'host';
        if (vm.cpu_model && CPU_MODELS[vm.cpu_model]) {
          baseCpuModel = vm.cpu_model;
        }
        cpuToUse = `${baseCpuModel},model-id=${vm.custom_cpu_name}`;
        console.log(`[VM-${vm.vm_id}] Using custom CPU: ${vm.custom_cpu_name} (base: ${baseCpuModel})`);
      } else if (vm.cpu_model && CPU_MODELS[vm.cpu_model]) {
        cpuToUse = vm.cpu_model;
        console.log(`[VM-${vm.vm_id}] Using preset CPU: ${cpuToUse}`);
      } else if (vm.cpu_model) {
        console.warn(`[VM-${vm.vm_id}] CPU model '${vm.cpu_model}' not found, falling back to 'host'`);
        cpuToUse = 'host';
        // Also update the database to fix the VM's CPU model
        db.run(`UPDATE vms SET cpu_model = 'host' WHERE vm_id = ?`, [vm.vm_id], (err) => {
          if (!err) console.log(`[VM-${vm.vm_id}] Updated database: cpu_model -> 'host'`);
        });
      }
      
      // Build QEMU command line as array (safer than string concatenation)
      // TCG fallback: if /dev/kvm is missing, use TCG (software emulation)
      const kvmAvailable = fs.existsSync('/dev/kvm') && (vm.enable_kvm !== 0);
      const accelStr = kvmAvailable ? `${vm.machine_type || 'pc'},accel=kvm` : `${vm.machine_type || 'pc'},accel=tcg`;
      
      const args = [
        `-m`, `${vm.memory}`,
        `-smp`, `cores=${vm.cpu_cores},threads=${vm.cpu_threads},sockets=${vm.cpu_sockets}`,
        `-cpu`, cpuToUse,
        `-name`, `vm-${vm.vm_id}`,
        `-machine`, accelStr,
        `-nographic`
      ];
      
      if (kvmAvailable) {
        args.push(`-enable-kvm`);
        console.log(`[VM-${vm.vm_id}] Using KVM acceleration`);
      } else {
        console.log(`[VM-${vm.vm_id}] /dev/kvm not available or disabled - falling back to TCG (software emulation)`);
      }
      
      // SMBIOS Configuration
      const smbiosManufacturer = vm.smbios_manufacturer || vm.custom_smbios_manufacturer || 'QEMU';
      const smbiosaProduct = vm.smbios_product || 'KVM Virtual Machine';
      const smbiosaVersion = vm.smbios_version || '1.0';
      const smbiosaSerial = vm.smbios_serial || `vm-${vm.vm_id}`;
      const boardName = vm.board_name || 'Main-Board';
      
      args.push(`-smbios`, `type=0,vendor=${smbiosManufacturer},version=${smbiosaVersion}`);
      args.push(`-smbios`, `type=1,manufacturer=${smbiosManufacturer},product=${smbiosaProduct},version=${smbiosaVersion},serial=${smbiosaSerial}`);
      args.push(`-smbios`, `type=2,manufacturer=${smbiosManufacturer},product=${boardName},version=${smbiosaVersion}`);
      
      console.log(`[VM-${vm.vm_id}] SMBIOS Config:`);
      console.log(`[VM-${vm.vm_id}]   Manufacturer: ${smbiosManufacturer}`);
      console.log(`[VM-${vm.vm_id}]   Product: ${smbiosaProduct}`);
      console.log(`[VM-${vm.vm_id}]   Board: ${boardName}`);
      console.log(`[VM-${vm.vm_id}]   Serial: ${smbiosaSerial}`);
      
      // ACPI configuration
      if (vm.enable_acpi === 0) {
        args.push(`-no-acpi`);
      }
      
      // Boot settings - check if ISO should boot first or disk
      if (vm.boot_from_iso && vm.iso_attached) {
        // Boot from ISO first, then fall back to disk
        args.push(`-boot`, `order=d,menu=off`);  // d = CDROM, then fallback
        console.log(`[VM-${vm.vm_id}] Boot Order: ISO (${vm.iso_attached}) → Disk`);
      } else {
        // Boot from HDD/disk only
        args.push(`-boot`, `c`);
        console.log(`[VM-${vm.vm_id}] Boot Order: Disk only`);
      }
      
      // Disable floppy device completely to avoid fd0 errors
      args.push(`-drive`, `if=floppy,index=-1`);
      
      // Drives - root disk
      // Always use disk_file for root filesystem (allows resizing)
      args.push(`-drive`, `file=${vm.disk_file},format=qcow2,if=virtio,media=disk`);
      
      // ISO media (if attached) - CD/DVD drive
      if (vm.iso_attached) {
        const isoPath = path.join(ISO_DIR, vm.iso_attached);
        if (fs.existsSync(isoPath)) {
          args.push(`-drive`, `file=${isoPath},format=raw,media=cdrom,if=ide,index=0`);
          console.log(`[VM-${vm.vm_id}] ISO Media Attached: ${vm.iso_attached}`);
        } else {
          console.warn(`[VM-${vm.vm_id}] ISO file not found: ${vm.iso_attached}`);
        }
      }
      
      // Cloud-init seed disk (CD-ROM) - MUST have for cloud-init to work
      const seedIso = path.join(VM_DIR, `vm-${vm.vm_id}-seed.iso`);
      if (fs.existsSync(seedIso)) {
        args.push(`-drive`, `file=${seedIso},format=raw,media=cdrom,if=ide,index=1`);
      }
      
      // Network Configuration
      const networkType = vm.network_type || 'dhcp';
      
      if (networkType === 'dhcp') {
        // DHCP with SSH port forwarding
        let netdevArgs = `user,id=net0,restrict=no`;
        
        // Use validated SSH port
        const sshPort = getSSHPort(vm);
        netdevArgs += `,hostfwd=tcp::${sshPort}-:22`;
        console.log(`[VM-${vm.vm_id}] SSH Port Forwarding: HOST:${sshPort} → VM:22`);
        
        args.push(`-netdev`, netdevArgs);
        args.push(`-device`, `virtio-net-pci,netdev=net0`);
        console.log(`[VM-${vm.vm_id}] Network: DHCP (SSH accessible via port ${sshPort})`);
      } 
      else if (networkType === 'static_public' || networkType === 'static_private') {
        // Static IP configuration with SSH port forwarding
        let netdevArgs = `user,id=net0,restrict=no`;
        
        // SSH port forwarding - use validated port
        const sshPort = getSSHPort(vm);
        netdevArgs += `,hostfwd=tcp::${sshPort}-:22`;
        console.log(`[VM-${vm.vm_id}] SSH Port Forwarding: HOST:${sshPort} → VM:22`);
        
        // HTTP port forwarding if specified
        const httpPort = getHTTPPort(vm);
        if (httpPort !== DEFAULT_HTTP_PORT) {
          netdevArgs += `,hostfwd=tcp::${httpPort}-:80`;
          console.log(`[VM-${vm.vm_id}] HTTP Port Forwarding: HOST:${httpPort} → VM:80`);
        }
        
        args.push(`-netdev`, netdevArgs);
        args.push(`-device`, `virtio-net-pci,netdev=net0,mac=${vm.mac_address || 'de:ad:be:ef:00:01'}`);
        
        const ipv4 = vm.ipv4_address;
        const gateway = vm.gateway;
        const dnsServers = vm.dns_servers || '8.8.8.8,8.8.4.4';
        console.log(`[VM-${vm.vm_id}] Network: Static ${networkType === 'static_public' ? 'Public' : 'Private'} IP`);
        console.log(`[VM-${vm.vm_id}] IPv4: ${ipv4}/${vm.netmask}, Gateway: ${gateway}, DNS: ${dnsServers}`);
      }
      else if (networkType === 'dual_stack') {
        // Dual stack IPv4 + IPv6 with SSH port forwarding
        let netdevArgs = `user,id=net0,restrict=no,ipv6=on`;
        
        // SSH port forwarding - use validated port
        const sshPort = getSSHPort(vm);
        netdevArgs += `,hostfwd=tcp::${sshPort}-:22`;
        console.log(`[VM-${vm.vm_id}] SSH Port Forwarding: HOST:${sshPort} → VM:22`);
        
        args.push(`-netdev`, netdevArgs);
        args.push(`-device`, `virtio-net-pci,netdev=net0`);
        
        console.log(`[VM-${vm.vm_id}] Network: Dual Stack (IPv4 + IPv6, SSH on port ${sshPort})`);
      }
      
      // VNC Server - Port 5900 + VM ID
      const vncPort = 5900 + parseInt(vm.vm_id);
      args.push(`-vnc`, `127.0.0.1:${vncPort}`);
      
      // Serial console with monitor support - stdin/stdout for direct terminal access
      args.push(`-serial`, `mon:stdio`);
      
      // Extra arguments if provided
      if (vm.extra_args) {
        args.push(vm.extra_args);
      }

      console.log(`[VM-${vm.vm_id}] CPU Config: ${vm.cpu_sockets} sockets x ${vm.cpu_cores} cores x ${vm.cpu_threads} threads = ${vm.cpus} total`);
      const cpuDisplayName = vm.custom_cpu_name || vm.cpu_model || 'host';
      console.log(`[VM-${vm.vm_id}] CPU Model: ${cpuDisplayName}`);
      console.log(`[VM-${vm.vm_id}] SMBIOS: ${vm.smbios_manufacturer} ${vm.smbios_product} (${vm.smbios_serial})`);
      console.log(`[VM-${vm.vm_id}] Network: ${vm.network_type || 'dhcp'} - IPv4: ${vm.ipv4_address || 'DHCP'}`);
      console.log(`[VM-${vm.vm_id}] Template: ${vm.template_type} (${vm.os_type})`);
      console.log(`[VM-${vm.vm_id}] Starting: ${vm.vm_name}`);
      console.log(`[VM-${vm.vm_id}] Image File: ${vm.img_file}`);
      console.log(`[VM-${vm.vm_id}] Console: Direct terminal access via -nographic -serial mon:stdio`);

      // Use spawn for background process execution
      const qemuProcess = spawn('qemu-system-x86_64', args, {
        stdio: ['ignore', 'pipe', 'pipe'],  // stdin: ignore, stdout: pipe, stderr: pipe
        detached: true,  // Let process run independently
        shell: false
      });

      const pid = qemuProcess.pid;
      
      // Save PID to file for later management
      fs.writeFileSync(pidFile, pid.toString());
      console.log(`[VM-${vm.vm_id}] ✓ Started with PID: ${pid}`);
      
      // Capture QEMU output to log file with rotation
      const rotateLogIfNeeded = () => {
        if (fs.existsSync(logFile)) {
          const stat = fs.statSync(logFile);
          if (stat.size > 10 * 1024 * 1024) {  // 10MB
            const backupFile = `${logFile}.${Date.now()}.bak`;
            fs.renameSync(logFile, backupFile);
            console.log(`[VM-${vm.vm_id}] Log rotated: ${backupFile}`);
          }
        }
      };
      
      if (qemuProcess.stdout) {
        qemuProcess.stdout.on('data', (data) => {
          rotateLogIfNeeded();
          fs.appendFileSync(logFile, data.toString());
        });
      }
      
      if (qemuProcess.stderr) {
        qemuProcess.stderr.on('data', (data) => {
          rotateLogIfNeeded();
          fs.appendFileSync(logFile, data.toString());
        });
      }
      
      // Handle process exit
      qemuProcess.on('exit', (code, signal) => {
        console.log(`[VM-${vm.vm_id}] Process exited with code ${code}, signal ${signal}`);
        try {
          fs.unlinkSync(pidFile);
        } catch (e) {}
      });
      
      qemuProcess.on('error', (err) => {
        console.error(`[VM-${vm.vm_id}] Process error: ${err.message}`);
        logError('QEMU', vm.vm_id, 'startup', err);
      });

      resolve({ pid, success: true });
    } catch (error) {
      logError('QEMU', vm.vm_id, 'initialization', error);
      reject(new Error(`Failed to start VM: ${error.message}`));
    }
  });
}

// Logout
app.post('/logout', (req, res) => {
  req.session.destroy(() => res.redirect('/login'));
});

// Redirect / to dashboard or login
app.get('/', (req, res) => {
  if (req.session.userId) {
    return res.redirect('/dashboard');
  }
  res.redirect('/login');
});

// ============= SETTINGS ROUTES =============

// Get all settings (no auth required for reading defaults)
app.get('/api/settings', (req, res) => {
  db.all(`SELECT setting_key, setting_value FROM settings`, (err, rows) => {
    if (err) return res.status(500).json({ error: err.message });
    
    const settings = {
      panel_version: 'V1.0',
      panel_title: 'HKVM Panel V1.0',
      panel_description: 'Professional VM Management Panel',
      site_icon_url: 'https://i.imgur.com/0DmkSi4.png',
      session_timeout: 24,
      max_sessions: 10
    };

    // Override with DB values
    if (rows && rows.length > 0) {
      rows.forEach(row => {
        settings[row.setting_key] = row.setting_value;
      });
    }

    res.json(settings);
  });
});

// Update setting (admin only)
app.post('/api/settings/:key', checkAuth, checkAdmin, (req, res) => {
  const { key } = req.params;
  const { value } = req.body;

  if (value === null || value === undefined) {
    return res.status(400).json({ error: 'Value required' });
  }

  db.run(
    `INSERT OR REPLACE INTO settings (setting_key, setting_value, updated_at) VALUES (?, ?, datetime('now'))`,
    [key, String(value)],
    (err) => {
      if (err) return res.status(500).json({ error: err.message });
      res.json({ success: true, key, value });
    }
  );
});

// Update multiple settings (admin only)
app.put('/api/settings', checkAuth, checkAdmin, (req, res) => {
  const settings = req.body;
  let completed = 0;
  const total = Object.keys(settings).length;
  const errors = [];

  if (total === 0) {
    return res.status(400).json({ error: 'No settings provided' });
  }

  Object.entries(settings).forEach(([key, value]) => {
    db.run(
      `INSERT OR REPLACE INTO settings (setting_key, setting_value, updated_at) VALUES (?, ?, datetime('now'))`,
      [key, String(value)],
      (err) => {
        completed++;
        if (err) {
          errors.push({ key, error: err.message });
        }
        
        if (completed === total) {
          if (errors.length > 0) {
            res.status(500).json({ success: false, errors, saved: total - errors.length });
          } else {
            res.json({ success: true, saved: total });
          }
        }
      }
    );
  });
});

// ============= USER PROFILE API =============

// Get user profile
app.get('/api/user/profile', checkAuth, (req, res) => {
  const userId = req.session.userId;
  if (!userId) {
    return res.status(401).json({ error: 'Not authenticated' });
  }
  
  db.get(
    `SELECT id, username, email, full_name, role, created_at, last_login FROM users WHERE id = ?`,
    [userId],
    (err, user) => {
      if (err) {
        console.error('[API Error] Failed to load profile:', err);
        // Fallback: try without full_name and last_login columns in case they don't exist yet
        db.get(
          `SELECT id, username, email, role, created_at FROM users WHERE id = ?`,
          [userId],
          (err2, user2) => {
            if (err2 || !user2) {
              return res.status(404).json({ error: 'User not found' });
            }
            // Add null values for missing columns
            user2.full_name = null;
            user2.last_login = null;
            res.json(user2);
          }
        );
        return;
      }
      
      if (!user) {
        return res.status(404).json({ error: 'User not found' });
      }
      
      res.json(user);
    }
  );
});

// Update user profile (name & email)
app.put('/api/user/profile', checkAuth, (req, res) => {
  const { full_name, email } = req.body;
  
  if (!email) {
    return res.status(400).json({ error: 'Email is required' });
  }
  
  db.run(
    `UPDATE users SET full_name = ?, email = ? WHERE id = ?`,
    [full_name || '', email, req.session.userId],
    function(err) {
      if (err) {
        if (err.message.includes('UNIQUE constraint failed')) {
          return res.status(400).json({ error: 'Email already in use' });
        }
        return res.status(500).json({ error: err.message });
      }
      res.json({ success: true, message: 'Profile updated successfully' });
    }
  );
});

// Change password
app.put('/api/user/password', checkAuth, (req, res) => {
  const { current_password, new_password } = req.body;
  
  if (!current_password || !new_password) {
    return res.status(400).json({ error: 'All password fields are required' });
  }
  
  if (new_password.length < 6) {
    return res.status(400).json({ error: 'New password must be at least 6 characters' });
  }
  
  // Get current password hash
  db.get(`SELECT password FROM users WHERE id = ?`, [req.session.userId], (err, user) => {
    if (err || !user) {
      return res.status(404).json({ error: 'User not found' });
    }
    
    // Verify current password
    if (!bcrypt.compareSync(current_password, user.password)) {
      return res.status(400).json({ error: 'Current password is incorrect' });
    }
    
    // Hash new password
    const hashedPassword = bcrypt.hashSync(new_password, 10);
    
    // Update password
    db.run(
      `UPDATE users SET password = ? WHERE id = ?`,
      [hashedPassword, req.session.userId],
      function(err) {
        if (err) {
          return res.status(500).json({ error: err.message });
        }
        res.json({ success: true, message: 'Password changed successfully' });
      }
    );
  });
});

// ============= SSH CONNECTION API =============

// SSH Connect endpoint - Test SSH connection
app.post('/api/ssh/connect', checkAuth, (req, res) => {
  const { vmId, host, port, username } = req.body;
  const userId = req.session.userId;
  
  if (!vmId || !host || !port || !username) {
    return res.status(400).json({ error: 'Missing connection parameters' });
  }
  
  // Verify VM ownership
  db.get(`SELECT * FROM vms WHERE vm_id = ? AND owner_id = ?`, [vmId, userId], (err, vm) => {
    if (err || !vm) {
      return res.status(403).json({ error: 'VM not found or access denied' });
    }
    
    // Generate session ID
    const sessionId = require('crypto').randomBytes(16).toString('hex');
    
    // Store connection info in memory
    global.sshSessions = global.sshSessions || {};
    global.sshSessions[sessionId] = {
      vmId: vmId,
      userId: userId,
      host: host,
      port: parseInt(port),
      username: username,
      password: null,
      createdAt: Date.now(),
      client: null
    };
    
    // Try to create SSH connection to verify it works
    const conn = new Client();
    const connConfig = {
      host: host,
      port: parseInt(port),
      username: username,
      password: '',
      tryKeyboard: true,
      readyTimeout: 5000,
      strict: false
    };
    
    conn.on('ready', () => {
      console.log(`[SSH] Connected to ${host}:${port}`);
      global.sshSessions[sessionId].client = conn;
      res.json({
        success: true,
        sessionId: sessionId,
        message: 'SSH session created and connected'
      });
    });
    
    conn.on('error', (err) => {
      console.log(`[SSH] Connection error: ${err.message}`);
      delete global.sshSessions[sessionId];
      res.status(500).json({ 
        error: 'SSH connection failed: ' + err.message 
      });
    });
    
    conn.connect(connConfig);
  });
});

// SSH Command endpoint - Execute command on VM
app.post('/api/ssh/command', checkAuth, (req, res) => {
  const { vmId, command } = req.body;
  const userId = req.session.userId;
  
  if (!vmId || !command) {
    return res.status(400).json({ error: 'Missing parameters' });
  }
  
  // Find an active session for this VM
  let session = null;
  if (global.sshSessions) {
    for (const [id, s] of Object.entries(global.sshSessions)) {
      if (s.vmId === parseInt(vmId) && s.userId === userId && s.client) {
        session = s;
        break;
      }
    }
  }
  
  if (!session || !session.client) {
    return res.status(404).json({ error: 'SSH session not found. Connect first.' });
  }
  
  // Execute command via SSH
  session.client.exec(command, (err, stream) => {
    if (err) {
      return res.status(500).json({ 
        error: 'Command execution failed: ' + err.message 
      });
    }
    
    let output = '';
    let errorOutput = '';
    
    stream.on('close', () => {
      res.json({
        success: true,
        output: output || errorOutput || '(no output)',
        error: errorOutput || null
      });
    });
    
    stream.on('data', (data) => {
      output += data.toString();
    });
    
    stream.stderr.on('data', (data) => {
      errorOutput += data.toString();
    });
  });
});

// ============= 404 HANDLER =============
app.use((req, res) => {
  res.status(404).render('users/404', {
    title: 'Page Not Found - HKVM Panel',
    message: 'Page not found'
  });
});

// START SERVER
initializeDatabase();

// WebSocket handler for VM console
const vmConsoles = new Map();
const sshSessions = new Map();

wss.on('connection', (ws, req) => {
  const url = req.url;
  console.log(`[WebSocket] New connection: ${url}`);
  
  // SSH Terminal WebSocket - Path: /ssh-terminal
  if (url.startsWith('/ssh-terminal')) {
    console.log(`[SSH-Terminal] New SSH terminal connection`);
    
    ws.on('message', async (message) => {
      try {
        const msg = JSON.parse(message.toString());
        
        if (msg.type === 'connect') {
          const { vmId, host, port, username, password } = msg;
          
          console.log(`[SSH-${vmId}] Initiating SSH connection to ${username}@${host}:${port}`);
          
          // Verify VM ownership
          db.get(`SELECT owner_id FROM vms WHERE vm_id = ?`, [vmId], (err, vm) => {
            if (err || !vm) {
              ws.send(JSON.stringify({ type: 'error', message: 'VM not found' }));
              return;
            }
            
            // Create SSH client
            const sshClient = new Client();
            
            sshClient.on('ready', () => {
              console.log(`[SSH-${vmId}] SSH client ready, opening shell`);
              
              sshClient.shell({ term: 'xterm-256color' }, (err, stream) => {
                if (err) {
                  console.error(`[SSH-${vmId}] Shell error:`, err.message);
                  ws.send(JSON.stringify({ type: 'error', message: 'Failed to open shell' }));
                  sshClient.end();
                  return;
                }
                
                console.log(`[SSH-${vmId}] Shell opened successfully`);
                ws.send(JSON.stringify({ type: 'connected' }));
                
                // Store session
                const sessionId = `${vmId}-${Date.now()}`;
                sshSessions.set(sessionId, { stream, client: sshClient, vmId });
                
                // Send raw data from SSH to WebSocket (binary, not JSON)
                // This preserves ANSI escape codes for proper terminal rendering
                stream.on('data', (data) => {
                  if (ws.readyState === WebSocket.OPEN) {
                    // Send raw binary data directly to xterm.js
                    ws.send(data, { binary: true });
                  }
                });
                
                stream.on('close', () => {
                  console.log(`[SSH-${vmId}] Shell closed`);
                  sshClient.end();
                  sshSessions.delete(sessionId);
                  if (ws.readyState === WebSocket.OPEN) {
                    ws.send(JSON.stringify({ type: 'closed' }));
                  }
                });
                
                stream.on('error', (err) => {
                  console.error(`[SSH-${vmId}] Stream error:`, err.message);
                  sshSessions.delete(sessionId);
                  if (ws.readyState === WebSocket.OPEN) {
                    ws.send(JSON.stringify({ type: 'error', message: err.message }));
                  }
                });
                
                // Store current session for this WebSocket
                ws.sshSessionId = sessionId;
              });
            });
            
            sshClient.on('error', (err) => {
              console.error(`[SSH-${vmId}] Connection error:`, err.message);
              ws.send(JSON.stringify({ type: 'error', message: `SSH Connection failed: ${err.message}` }));
              if (ws.readyState === WebSocket.OPEN) {
                ws.close();
              }
            });
            
            sshClient.on('close', () => {
              console.log(`[SSH-${vmId}] SSH connection closed`);
              if (ws.readyState === WebSocket.OPEN) {
                ws.close();
              }
            });
            
            // Connect to SSH server
            sshClient.connect({
              host: host,
              port: parseInt(port),
              username: username,
              password: password,
              readyTimeout: 30000,
              algorithms: {
                serverHostKey: ['ssh-rsa', 'ecdsa-sha2-nistp256', 'ssh-ed25519']
              }
            });
          });
        } else if (msg.type === 'input' && ws.sshSessionId) {
          // Send user input to SSH shell (handle binary input)
          const session = sshSessions.get(ws.sshSessionId);
          if (session && session.stream) {
            session.stream.write(msg.data);
          }
        }
      } catch (err) {
        console.error('[SSH-Terminal] Message error:', err.message);
        ws.send(JSON.stringify({ type: 'error', message: 'Invalid message format' }));
      }
    });
    
    ws.on('close', () => {
      console.log(`[SSH-Terminal] WebSocket closed`);
      if (ws.sshSessionId) {
        const session = sshSessions.get(ws.sshSessionId);
        if (session) {
          try {
            session.stream.end();
            session.client.end();
          } catch (e) {
            console.error('[SSH-Terminal] Error closing session:', e.message);
          }
          sshSessions.delete(ws.sshSessionId);
        }
      }
    });
    
    ws.on('error', (err) => {
      console.error(`[SSH-Terminal] WebSocket error:`, err.message);
    });
    
    return;
  }
  
  // VNC WebSocket Tunneling - Path: /vnc/1 connects to 127.0.0.1:5901
  if (url.startsWith('/vnc/')) {
    const vmId = url.split('/vnc/')[1].split('?')[0];
    
    if (!vmId || isNaN(vmId)) {
      console.log(`[VNC] Invalid vmId: "${vmId}"`);
      ws.close();
      return;
    }

    const vncPort = 5900 + parseInt(vmId);
    const vncHost = '127.0.0.1';

    console.log(`[VNC-${vmId}] New VNC connection, tunneling to ${vncHost}:${vncPort}`);

    const socket = net.createConnection({ port: vncPort, host: vncHost }, () => {
      console.log(`[VNC-${vmId}] Connected to QEMU VNC server`);
    });

    socket.on('data', (data) => {
      if (ws.readyState === WebSocket.OPEN) {
        ws.send(data, { binary: true });
      }
    });

    socket.on('error', (err) => {
      console.error(`[VNC-${vmId}] Socket error:`, err.message);
      ws.close();
    });

    socket.on('close', () => {
      console.log(`[VNC-${vmId}] Socket closed`);
      ws.close();
    });

    ws.on('message', (data) => {
      try {
        if (socket.writable) {
          socket.write(data);
        }
      } catch (err) {
        console.error(`[VNC-${vmId}] Write error:`, err.message);
      }
    });

    ws.on('close', () => {
      console.log(`[VNC-${vmId}] WebSocket closed`);
      socket.destroy();
    });

    ws.on('error', (err) => {
      console.error(`[VNC-${vmId}] WebSocket error:`, err.message);
      socket.destroy();
    });

    return;
  }
  
  // Extract vmId from URL path like /console/1 or just /1
  let vmId = null;
  if (url.includes('/console/')) {
    vmId = url.split('/console/')[1].split('?')[0];
  } else {
    vmId = url.split('/').pop().split('?')[0];
  }
  
  if (!vmId || vmId === '' || isNaN(vmId)) {
    console.log(`[WebSocket] Invalid vmId: "${vmId}"`);
    ws.send(JSON.stringify({ type: 'output', data: '\x1b[31m✗ Invalid VM ID\x1b[0m\r\n' }));
    ws.close();
    return;
  }

  console.log(`[Console-${vmId}] Client connected`);
  
  const logFile = path.join(VM_DIR, `vm-${vmId}.log`);
  let lastSize = 0;
  let watchInterval = null;

  // Send initial content
  db.get(`SELECT * FROM vms WHERE vm_id = ?`, [vmId], (err, vm) => {
    if (err) {
      console.error(`[Console-${vmId}] DB error:`, err.message);
      ws.send(JSON.stringify({ type: 'output', data: `\x1b[31m✗ Database error\x1b[0m\r\n` }));
      return;
    }

    if (!vm) {
      console.log(`[Console-${vmId}] VM not found`);
      ws.send(JSON.stringify({ type: 'output', data: `\x1b[31m✗ VM ${vmId} not found\x1b[0m\r\n` }));
      return;
    }

    let intro = '';
    if (vm.status === 'running') {
      intro = `\x1b[32m✓ VM ${vmId} is RUNNING\x1b[0m\r\n`;
    } else {
      intro = `\x1b[33m⚠ VM ${vmId} is ${vm.status.toUpperCase()}\x1b[0m\r\n`;
    }

    // Read and send existing log
    if (fs.existsSync(logFile)) {
      try {
        const content = fs.readFileSync(logFile, 'utf8');
        lastSize = content.length;
        ws.send(JSON.stringify({ 
          type: 'output', 
          data: intro + content 
        }));
        console.log(`[Console-${vmId}] Sent ${content.length} bytes of log`);
      } catch (e) {
        console.error(`[Console-${vmId}] Read error:`, e.message);
        ws.send(JSON.stringify({ type: 'output', data: intro + '\x1b[33m(Log file error)\x1b[0m\r\n' }));
      }
    } else {
      ws.send(JSON.stringify({ type: 'output', data: intro + '\x1b[36m[Console ready]\x1b[0m\r\n' }));
    }

    // Start watching for new output (50ms interval for near real-time)
    watchInterval = setInterval(() => {
      if (!ws || ws.readyState !== WebSocket.OPEN) {
        if (watchInterval) clearInterval(watchInterval);
        return;
      }

      try {
        if (fs.existsSync(logFile)) {
          const stat = fs.statSync(logFile);
          if (stat.size > lastSize) {
            const fd = fs.openSync(logFile, 'r');
            const buffer = Buffer.alloc(stat.size - lastSize);
            fs.readSync(fd, buffer, 0, stat.size - lastSize, lastSize);
            fs.closeSync(fd);
            
            lastSize = stat.size;
            const newData = buffer.toString('utf8');
            
            // Send to all clients for this VM
            if (vmConsoles.has(vmId)) {
              vmConsoles.get(vmId).forEach(client => {
                if (client.readyState === WebSocket.OPEN) {
                  client.send(JSON.stringify({ type: 'output', data: newData }));
                }
              });
            }
          }
        }
      } catch (e) {
        console.error(`[Console-${vmId}] Watch error:`, e.message);
      }
    }, 50);
  });

  // Store client
  if (!vmConsoles.has(vmId)) {
    vmConsoles.set(vmId, []);
  }
  vmConsoles.get(vmId).push(ws);

  // Handle input from terminal
  ws.on('message', (message) => {
    try {
      const msg = JSON.parse(message);
      if (msg.type === 'input' && msg.data) {
        // Append to log file
        fs.appendFileSync(logFile, msg.data);
        
        // Broadcast to other clients
        if (vmConsoles.has(vmId)) {
          vmConsoles.get(vmId).forEach(client => {
            if (client !== ws && client.readyState === WebSocket.OPEN) {
              client.send(JSON.stringify({ type: 'output', data: msg.data }));
            }
          });
        }
        
        console.log(`[Console-${vmId}] Input: ${msg.data.length} bytes`);
      }
    } catch (e) {
      console.error(`[Console-${vmId}] Message parse error:`, e.message);
    }
  });

  // Handle disconnect
  ws.on('close', () => {
    console.log(`[Console-${vmId}] Client disconnected`);
    
    if (vmConsoles.has(vmId)) {
      const clients = vmConsoles.get(vmId);
      const idx = clients.indexOf(ws);
      if (idx > -1) {
        clients.splice(idx, 1);
      }
      
      // Clean up interval if no more clients
      if (clients.length === 0) {
        vmConsoles.delete(vmId);
      }
    }
  });

  ws.on('error', (error) => {
    console.error(`[Console-${vmId}] WebSocket error:`, error.message);
  });
});

server.listen(PORT, async () => {
  try {
    // Initialize license system
    console.log('[License] Initializing license storage...');
    await licenses.initLicenseStorage(dbPath);
    console.log('[License] License storage initialized successfully');
    
    // Start background license revalidation
    licenses.startBackgroundRevalidation();
    console.log('[License] Background revalidation thread started');
    
    // ============= BACKGROUND LICENSE VALIDATION EVERY 5 MINUTES =============
    // Simple check: if license key exists locally, keep it active
    // If key is missing, deactivate
    setInterval(async () => {
      try {
        const state = await licenses.getState();
        if (!state) return;

        const currentActivated = await licenses.isActivated();

        if (currentActivated) {
          console.log('[License] Background check running (every 5 minutes)...');
          
          // Simple check: just verify the encrypted key blob exists
          if (state.key_blob) {
            console.log('[License] ✓ License key found locally - keeping active');
            // License stays active as long as key_blob exists
          } else {
            console.warn('[License] ✗ License key not found locally - deactivating');
            // Key is missing, deactivate the license
            await licenses.deactivateLocal('License key not found during background check');
          }
        }
      } catch (error) {
        console.error('[License] Background check error:', error.message);
      }
    }, 5 * 60 * 1000); // 5 minutes
    
  } catch (error) {
    console.error('[License] Failed to initialize license system:', error.message);
    process.exit(1);
  }

  // Fix any VMs with invalid CPU models on startup
  const validCpuModels = Object.keys(CPU_MODELS);
  db.all(`SELECT vm_id, cpu_model FROM vms WHERE cpu_model NOT IN (${validCpuModels.map(() => '?').join(',')})`, validCpuModels, (err, vms) => {
    if (!err && vms && vms.length > 0) {
      console.log(`[Startup] Found ${vms.length} VMs with invalid CPU models, fixing...`);
      vms.forEach(vm => {
        console.warn(`[Startup] VM ${vm.vm_id}: CPU model '${vm.cpu_model}' is not available, resetting to 'host'`);
        db.run(`UPDATE vms SET cpu_model = 'host' WHERE vm_id = ?`, [vm.vm_id]);
      });
    }
  });

  console.log(`
╔════════════════════════════════════════════════════════════╗
║           HOPINGBOYZ VM MANAGEMENT PANEL V1.0              ║
║          Advanced VM Management & Control Panel            ║
╚════════════════════════════════════════════════════════════╝

✓ Server: http://localhost:${PORT}
✓ Database: ${dbPath}
✓ VM Directory: ${VM_DIR}

Open http://localhost:${PORT} to begin
  `);
});

module.exports = app;
{"mode":33188,"size":167097,"isFileValue":true,"isDirectoryValue":false,"isSocketValue":false,"isSymbolicLinkValue":false}{
  "name": "hopingboyz-vm-manager",
  "version": "1.0.0",
  "description": "Web-based VM Management Panel powered by Hopingboyz",
  "main": "app.js",
  "bin": "app.js",
  "scripts": {
    "start": "node app.js",
    "dev": "nodemon app.js",
    "test": "echo \"Error: no test specified\" && exit 1",
    "build": "pkg app.js -t node16-linux-x64 -o hopingboyz-vm-manager.bin"
  },
  "keywords": [
    "vm",
    "qemu",
    "kvm",
    "virtualization",
    "management"
  ],
  "author": "Hopingboyz",
  "license": "MIT",
  "dependencies": {
    "bcryptjs": "^2.4.3",
    "bytenode": "^1.6.0",
    "cors": "^2.8.5",
    "dotenv": "^16.6.1",
    "ejs": "^6.0.1",
    "express": "^4.18.2",
    "express-session": "^1.17.3",
    "postject": "^1.0.0-alpha.6",
    "sqlite": "^5.1.1",
    "sqlite3": "^5.1.6",
    "ssh2": "^1.17.0",
    "uuid": "^14.0.2",
    "ws": "^8.14.2"
  },
  "devDependencies": {
    "javascript-obfuscator": "^5.5.1",
    "nodemon": "^3.0.1",
    "pkg": "^5.8.1"
  },
  "pkg": {
    "scripts": [
      "app.js",
      "licenses.js"
    ],
    "assets": [
      "public/**/*",
      "views/**/*"
    ]
  }
}
{"mode":33188,"size":1125,"isFileValue":true,"isDirectoryValue":false,"isSocketValue":false,"isSymbolicLinkValue":false}(��t��yӐ  g=�!J:>�h�           T$�`       �
`        ua        
̆	�q`        Te�`    �  �`        p�z    �   , �� 	 t 
� 	 � 	 � 	 � � H	K� #� �
�	TS�	 �� � ��	 /� L h ��4�����ȹ`dl\\dLH`P<HDDld�lX�XxLp�
� �m�`    Y   }Sb    �q            +   RaB��   require RaJͪ�   fs      RaNi�b   crypto  Ra�3x   https   Ra��n   http    Ra
��   URL     Ra�w8   sqlite3 Rar� �   open    Rc ��   LICENSE_SERVER_URL      Rb��A�   MAX_ENVELOPE_AGERb�ϒK   HTTP_TIMEOUT    Rb�WM   PANEL_VERSION   RbFZ�
   DEBUG_MODE      Rc�Џ�   EMBEDDED_PUB_KEY_PEM    Ra���   dbPath  Ra�%t}   db      Rb���C   publicKeyObj    Ra�p
   logger  Ra��   utcNow  Ra^�l�   sha256  RdR=z   generateMachineIdFromHardware   Rd����   generateHardwareFingerprint     Ra~�n�   xorBytesRb~7(�   keyForMachine   Rb�F&�
   encryptKey      Rb���
   decryptKey      Rb��   resolvePubKeyPemRb�v��   loadPublicKey   Rb
��   getServerUrl    Rc�}��   initLicenseStorage      Rc���   attemptLicenseRecovery  Ra�:�   getStateRb��Ŋ   updateState     Rb���   getMachineId    Rc
��   verifySignedResponse    Rc���   verifyCachedEnvelope    Rb
��G   buildRequest    Rb*?e�   makeRequest     Rc��n   activateWithServer      Rc>�o   revalidateWithServer    Rb���   isActivated     Rb�0�   getStatusInfo   Rb�J�Y   deactivateLocal �    S       ��?     ��?     ��?     ��?     ��?     ��?     ��?     ��?     ��?     ��?     ��?     ��?     ��?     ��?     ��?     ��?     ��?     ��?     ��?     ��?     ��?     ��?     ��?     ��?     ��?     ��?     ��?     ��?     ��?     ��?     ��?     ��?     ��?     ��?     ��?     ��?     ��?     ��?     ��?     ��?     ��?     ��? I`    ����Da    
       ѐ   T,�`       ��`        �b       �K(	, 8   ��`       � �gd              !  �l�� �/��`���    (Sb    �qA                 t`    ����Da    t	      �	  (�a       P    H�
 Qdz5��   /snapshot/hkvm/licenses.js      a                Db                   n   D`        �Y`    7     T8�`    ,   �
`        uc       �; T	 H	, c
�  �q`       � B�Ra"���   [INFO]  � �gg8              ���!  �/���!�l�� �/��`��
���g���    (Sb    bpV                  b�`    ����Da    _      �  (�b       ` @        �b      K�    O       T8�`    ,   �
%`        uc       �= T	 L	, g
�  �q`       � ��Ra��c   [WARN]  � �gg8              ���!  �/���!�l�� �/��`��
���g���    (Sb    bpV                  ��`    ����Da    �      �  (�b       ` @        �b      K�    P       T8�`    ,   �
E`        uc       �@ T	 T	, o
�  �q`       �=Ra�H8�   [ERROR] � �gg8              ���!  �/���!�l�� �/��`��
���g���    (Sb    bpV                 �`    ����Da          M  (�b       ` @        �b      K�    Q       T<�`    7   �
e`        ud       �B `�	 T	, o�       � q`       \� �Ra�Z��   [DEBUG] � �gh8              ���� ���*! �/���!�l�� �/��`��
���g��� (Sb    bpV                  �`    ����Da    [      �  (�b       ` @        �b      K�    R       T8�`    ,   �
�`        uc       �G T	 d	, 
�  �q`       �=Rb�qǕ   [EXCEPTION]     � �gg8              ���!  �/���!�l�� �/��`��
���g���    (Sb    bpV                 M`    ����Da    �      G	  (�b       ` @        �b      K�    S      � T8�`    ,   �
�`        uc       �M88 P0
8     � q`       4Rbb�#5
   createHash      xRaN���   update  Ra~�"y   digest  RaV���   hex     g(              � �/� ��a����/��a���/���a���
�    (Sb    �qA                �`    ����Da    �	      
  (�a       P @ �b    @    1       T��`    :  �
�`        �u�    �  �X � 
� #
� 
� �� 
Tp$� 
��  8/> )+U��*> �0
�('�����	 P`$�0$�	3#� ,d@`*�	3+� ,t<h-3����	33� ,tDt-?���.����0$�$$ G8�	� 5k����$$ G8�	� 5k���� 
��
D\X$�	p #D ,�	 � 
�	� H��D���� +
�$       p�z    �      !  9        �  �6      �   '  y  &   �   .  �	  -   F  [  �
  /   �  �  �  ,   �    )  -   ?  T  �  '   �  y  �#  !   *  �  �  "   �  F  A"  "   �  (  Q)  !   ^  �  ).  !   aqe    V       �      @      �      �      �  Ra�b   os      Rb����   child_process   QRaJ�<�   util    Rb��s	   promisify       IRa�}2U   hostnameRb����	   hostname:        B7Rc&�1   networkInterfaces       � 2���}Raʵ>�   mac     Rc��Y�   00:00:00:00:00:00        ">`    m   @ Ra}9�   macs:   Ra�6!   process Rav��   platformRa�78@   win32   RcJ�S�   wmic csproduct get uuid Ra���   stdout   "X � bZRa*�N�   uuid:   Rd�ɴp   wmic bios get serialnumber      Ra����   serial: Sb    % @                 �.`    ��? (p �Rd�ta   Could not get BIOS serial:      mRd�[�   wmic baseboard get serialnumber RbZ�[
   mb_serial:      Sb    % @                 �.`    ��? �RcBZL�   Could not get MB serial:Sb    % @                 �.`    ��? �Re
��"   Windows hardware detection failed:      `    �  Ra��Fs   linux   0Ra�
�q   promisesRa�B   readFileRbҫ�   /etc/machine-id RaΠL   utf8    Rb"�U   machine-id:     Sb    % @                 �.`    ��? �Rd*�+   Could not read /etc/machine-id: Re�&�&   /sys/class/dmi/id/system-serial-number  Rb:L�   dmi_serial:     Sb    % @                 �.`    ��? �Rd�a��   Could not read DMI serial:      a    8      J  RaJ�t   cpus    Ra
.��   model   ��Ra���   cpu:    Rb�a_   |cpu_count:     Rb����	   platform:       Ra��/_   |arch:  Ra��   arch     b�$Rg��O�8   [License] Generated machine ID from hardware fingerprintRd�!,   [License] Hardware components:   �XRa����   ...     Sb    % @                =`    ��? �� Rf���)   [License] Hardware fingerprinting failed:       Ra~�   uuid    RaZ+�   v4      Sb    % @                �`    ��? ���     ����    �� ���k��������e�� ���e���/����e���/�	�a���
�
�/��`�����{;��;�;����/��`�����!�/��a���ֶ��/�!�����`��#Ҥh� �/�%�/�'������)+�/�-����ϛ%�`��3ˤh� �/�1�/�/��ˏ�ϛ%�`��5ˤh� �/�1�/�/��ˏ���Ώ����ϛ&��/�7��`��9��h� ���Νʭ̫Ξ
��ԏ���;=�/�?�����`��A̤h� �/�C�9/�E������/�G� /�G�p�I�/�J�/�G�a���L�IN��Ϗ����Л&��/�O��`��Q��h� ���ϝ̭ͫϞ
��ԏ �z  S ��Տ����֛&��/�T��`��V��h� ���՝ҭӫ՞ԭ/�X�`��Z�/�\��a���^���{;�a�;�a;�`���!b�/�d�p�f�2���e��g���k ����" ���"�k��֝׭/� i�/�!k�"�a���m�1�o֣/�#q�`��s��$��{;�v�;�v;�u�����%�e��w���k ����#���#�k��՝֭/� y�/�!{�"�a���}�1�գ/�#��`�Ճ��&��{;Ն�;Ն;�����3և�'����� �(�/�)��*��/�+��b���ҋ���,�e�Ս���k ����#���#�k��՝֭/� ��/�!��"�a��ӓ�1Օգ/�#��`�ՙ��-��{;՜�;՜;�����3և�.����� �(�/�)��/��/�+��b���ҝ֏3ׇ�0����� �(�/�)��1��/�+��b���ӟאA!b�/�d�3pء�@���4�/�5��/�6��7�8�b���Ԧ���k ����"���"�k��֝׭��9�/�#��`��{;֩�;֩;�����3ׇ�:����� �(�/�)��;��/�+��b���Ӯ����4�/�5��/�6��<�8�b���Բ���k ����"���"�k��֝׭��=�/�#��`��{;ֵ�;ֵ;�����3ׇ�>����� �(�/�)��?��/�+��b���Ӻ�/�B��`����1��أ/�C�D�/�EĺF��{;���G;����{;���;��;�����H�!b�/�d{;���I;���!b�/�J�{;���;��;������e�����(�/�K��L�a�����/�)��M�/�N���d�b������O;���b���������k��؇�P����� �(�/�Q��R��/�+��b������ �S�e����/�T��d�����k��ه�U�������k��      (Sb    �q[                 |`    ����Da            (T�s�       P @  !0� 
����
��
� � 
����
 @ � .P @ P ��
� 
� 	�� � �
� 
� �  � "@ @ @ @ @ P BX @ � � �  �b   ,  MQ 	   2       TI�`    I  �
�`        tu{    �   �� � 
� #
� 
� ��	x � 
��  8/> )+S��*> �0
�('�����	t  �0$�	3+
� ,d(`/����0$�$$ G8�	� 'o����	P����0      X�t    �      0  �!        �  �     �     !     �   #  X	  !   ;  P  �
  #   ~  �  �      �  �  �  !   4  I  Y     �  	  Y     S  �  �     �qb    4       �      �  ��Q��I���� 2���} ">`    l  RaB5�   |macs:   @  B "X � bZRa:��   |uuid:  Sb    % @                 �.`    ��? (p �Rd��   Could not get Windows UUID:     mM0QUY]Rb�O�@   |machine-id:    Sb    % @                 �.`    ��? (iSb    % @                =`    ��? � ��Rd6N�   Hardware fingerprinting failed: Sb    % @                �`    ��? �10     ����    �� ���k��������e�� ���e���/����e���/��a���
���/�	�`��{;�;����/�
�`�����!�/��a������/�!�����`��#ޤh� �/�%�/�'������)+�/�-����ۛ%�`��3פh� �/�1�/�/��׏�ۛ%�`��5פh� �/�1�/�/��׏���ڏ����ۛ&��/�7��`��9��h� ���ڝ֭ثڞ
�������;=�/�?�����`��Aؤh� �/�C�9/�E������/�G� /�G�p�I�/�J�/�G�a���L�IN��ۏ����ܛ&��/�O��`��Q��h� ���۝ح٫۞
���� �y  S ��������&��/�T��`��V��h� ����ޭ߫���/�Z�`��\�/�^��a���`{;�Y;�X���!b�/�d�p�f�����e��g���k ���� ����k����/�i�/�k��a���m�1�o�/� q�`��s���!��{;�v;�u��3��"����� �#�/�$w�%��/�&y�b����{㏨!b�/�d�'p�}�����(�/�)~�/�*��+�,�b��������k ��������k������-�/� ��`��{;�;���3��.����� �#�/�$w�/��/�&y�b���ߊ��e�����k����0����� �#�/�1��2��/�&y�b��������k����3�������k��       (Sb    �q[                 �`    ����Da    �      O"  �<�m�       P @ @ 0� 
����
��
� � 
����
 @ � . !P P ��
� 
� � "@ @ P        �b   *  MQ 
   3       TL�`    T   �
	`        $ug    5   ��L	@
0T	,+�0	
|@	H	'c��8   �q`       �Rav~:   Buffer  Raz���   alloc   l(              �/  �p���!�/��/ �a���	��/ q��"�1�/  ?�1B�7���SȎ% ��    (Sb    �qA                �`    ����Da    d"      O#  (�b       D
� "� � �b    @    4       TT�`    b   �
-`        ue    '   ��d8 x 	X	D	C�	�7�$ �0q`    
   4�x� B:�
`        Lb                       uRb�bG�	   license::       �nP              � �/� ��a����/��!�/��~
%��!�/���;��a���9���9��a����a����/�	�`���      (Sb    �qA                �`    ����Da    i#      .$  (�c       P 0 � P        �b    @    5       TX�`    k   �
U`         uf    *   ��� �$	 T��	8 	7P
L      �,q`    	   4RbJ��c   randomBytes     u] B:�
`        Lb                       E	Ravѓ�   base64  o8              � �/� ��a�����!�/���b�����f��
�f����!�/��~%���9����9��a����/���a����     (Sb    �qA                �`    ����Da    E$      %  (�c       ` @ 0��        �b    @    6       TT�`    h   �
�`         uf    -   ȩp80�	 � � PX;�
D�0   �b       	   [   �     $q`       uq �?E	]Sb    % @                =`    ��? (n@              ����!  �/���b����/����b�����/���a���
���f���f����/���a����Ň������(Sb    �qA                �`    ����Da    1%      |&  ��b       @ @ P    �b    @    7       T��`    �   �
�`        8ul    ]   ĵ�	$h 
4T
D8�	$| 
4	< �( t����
l@ � 
�0L,   �b       _   }   �     \q`       RaB�z/   env     RcH��   LICENSE_PUBLIC_KEY      I bZ�Rc���   LICENSE_PUBLIC_KEY_FILE 0RbZ��
   existsSync      RbZ�>   readFileSync    ]Sb    % @                =`    ��? (p ��Re���'   Could not read LICENSE_PUBLIC_KEY_FILE: m` �@Re斆&   REPLACE_WITH_YOUR_PUBLIC_KEY_PEM_BLOCK  �@RnV�v�m   License public key is not configured. Set LICENSE_PUBLIC_KEY environment variable or LICENSE_PUBLIC_KEY_FILE.   |H              !  �/��/���/��`��ɜ/�
�2r����!  �/��/���/��`��Ȝ^��/��a����M����/�	�
�b�����/��`���Ň������ ��/����/�!�b����#��ǜ/�%��a���'���/�)��a���+���    (Sb    �qA                 �`    ����Da    �&      c*  ��d-       P P ��� 
����� 
�   �b     @    8       TX�`    i   �
�`        (uh    9   ��(HPH d@ � 
�0�4@P����0       �b       8   ?   �     ,q`    	   l �@�p=4Rk�UKS   License public key is not configured. Run the setup script to provision this panel.     Sb    % @                �`    ��? (Re�ˢh"   Failed to load license public key:      mo8              � ���d� ɜ/���a������/���a�������%�Ǉ������ ��/����/�
�b�����       (Sb    �qA                 �`    ����Da    }*      -  ��b       @ P        �b     @    9       TP�`    Z   �
`        ue    (   ��X � T��D8	 7��,q`    	    "X � C T(�`    
   �)`        �b    
   ��4       ��`        bZc              /  �`��      (Sb    bpW                I`    ����Da    �-      �-  (�a             �b     K�    c       �A T(�`    
   �
E`        ub    
   ��4      �q`       �c              /  �r��      (Sb    bpW                I`    ����Da    �-      �-  (�a       D      �b     K�    d       um@              �d� �/� ��a����/�Ņ �a����/�
ƅ�a����/���a�����!�/��a����e���      (Sb    �qA                 RcNF=   getPublicKeyFingerprint `    ����Da    1-      .  ��c      @ P @ @        �b      @    :      %A T0�`       �
m`        ub       ��(h L    �q`       L �VRaf��=   \/$     Ie               
� �/� �}  ��b�����      (Sb    �qA                 �`    ����Da    ..      h.  (�a       L     �b     @    ;       T��`    !  �
�`        �u�    �   �� n�t�d��t �3�$ #.�$ #L����$ #.�
�"< )S��	$��#Y���$ #4�
H$ #2�4�$ #4�	T�$'�	�#.� �,
� 
��, K�	�
�� O�	�
�$'�	�#2�
 
� �      H�p    �      &   C     A     [(     �     a     }  �  �     �    H       .  �     M  �  �     �  �       �qk    <       �       �       �       W      �            R      y      �      �      �  Sb    % @                �`    ��? (dhH �b                     Raj1g   filenameCRa�J��   driver  C�DRab�D/   Database�QRd+��   PRAGMA journal_mode = WAL       Rdr���   PRAGMA busy_timeout = 5000      Sb    % @                 �.`    ��? (p �Rcz��g   Could not set WAL mode: myRu�w;��  
        CREATE TABLE IF NOT EXISTS license_state (
            id INTEGER PRIMARY KEY CHECK (id = 1),
            machine_id TEXT,
            hardware_fingerprint TEXT,
            status TEXT,
            usage_type TEXT,
            max_activations INTEGER,
            owner TEXT,
            expires_at TEXT,
            last_check_at TEXT,
            last_success_at TEXT,
            last_error TEXT,
            failure_count INTEGER NOT NULL DEFAULT 0,
            activation_failures INTEGER NOT NULL DEFAULT 0,
            activated_at TEXT,
            activated_by TEXT,
            server_url TEXT,
            key_blob TEXT,
            cached_envelope TEXT,
            cache_integrity_check TEXT
        )
           �
`       PL`       �`       M`       RbN<l
   machine_id      Ra��   TEXT    �`       M`       RcF)W�   hardware_fingerprint    ��`       M`        ����`       M`       Rb"<�e
   usage_type      ��`       M`       RbZ�?D   max_activations RaFM��   INTEGER �`       M`       RaNP�;   owner   ��`       M`       Rb�'7
   expires_at      ��`       M`       Rb��L&   last_check_at   ��`       M`       RbN�   last_success_at ��`       M`       Rb X�
   last_error      ��`       M`       RbfZ��   failure_count   Rd�$�   INTEGER NOT NULL DEFAULT 0      �`       M`       RcbT�   activation_failures     Y�`       M`       Rb>�k�   activated_at    ��`       M`       Rb��q�   activated_by    ��`       M`       Rbf0�
   server_url      ��`       M`       Rafe{]   key_blob��`       M`       Rb�X�   cached_envelope ��`       M`       Rc����   cache_integrity_check   ����}Re�I^%   ALTER TABLE license_state ADD COLUMN     �Sb    % @                =`    ��? (`    $  � Rf��B�)   SELECT COUNT(*) as cnt FROM license_state       Raڮ9e   cnt     Ra�b�K   run     (RhVŴZ;   INSERT INTO license_state (id, failure_count) VALUES (1, 0)     $Rg�U�m1   SELECT machine_id FROM license_state WHERE id = 1       �$Rg�C4   UPDATE license_state SET machine_id = ? WHERE id = 1    �
`        La                b�,Ri6��A   [License] Machine ID derived from hardware and stored in database        ��(RhF�:   [License] Hardware mismatch detected - updating machine ID      Rc�D��   [License] Previous:      �X�RcN4��   [License] Current:      �`        La               Rb~n��
   setTimeout       Td�`    �   �
�`        ud       �� �L���"�     �d           r   �        :   �     $qa           (   Sb    % @                =`    ��? (p�Re�f�"   [License] Deferred recovery error:      mSb    % @                �`    ��? �r@      ����    �� ���k������ �d� ���k ���� ����k��������,Ƈ������ ��/����/��b��������k��Ǉ��������k��(Sb    bpY                 I`    ����Da    �=      �>  ��a       P    �b      LP    b      (Rh:V@   [License] License storage initialized with auto-recovery enabledSb    % @                �`    ��? ���      ����    �� ���k���������ȏ����������k������
��%����%�L	��� )��6���/�6�e�����k���� ����k������%���/�	��a������k ��������k�����/�	��a������k ��������k�����0�������� ��/����/��b������/�	��a������k��������k����~Ŷ��/������`���h� �/� �%/� "������$&�/�(�����%�`��.ߤh� �/�,�/� *��ߏ��%�`��0ߤh� �/�,�/� *��ߏ���������&��/�!2��`��4��h� ����ޭ��
���y���/�	�"��{;�6�#;�6��{;�6�a���7���k ��������k�������$����� �0  9 ��������&��/�!:��`��<��h� ���������/�&>�'�a���@���k��������k������/�(B�p�D�3�/�)E�*�a���G���k��������k������d�I���k��������k�������/�&>�+�a���K���k��������k�������/�,M�U�/�)E�-�~.O%���9��Pb����R���k����	����k������/�/T�0�a���V��/�,M��p�X����/�1Y�2�a���[�/�1Y�3�/�,M�/�4]���b����_;�a�5;�b�a���c�/�1Y�6�/�4e���b����g;�i�5;�j�a���k�/�)E�-�~7m%���9��nb����p���k����
����k�����!8r��9 � ��f���t��/�/T�:�a���v���k�����;�������k��       (Sb    �qZ                �`    ����Da    �.      ?  �0�jx      ������
� &P P P @ @ ��[ @ �� 
`>@ �� B
� 	`>@ @ �b   !  MQ    <      � Te�`    �  �
5`        puz    �   �� �4l0�XH��\�4�\ 
��d 
��D@��� 
�| �4�p 
�� 
�4�p 
����&���*�0L  � ���"�      �f    0      r  �          A     !  �  �     �qd    "       (       �       4      �   ��Ra63+�   active  ���	p b�(Rhl�Z9   [License] License already active and verified in database        �$Rg�>�k2   [License] No stored license key found for recovery       �� Rf���!.   [License] Could not decrypt stored license key  ,Ri����C   [License] Found encrypted license key - attempting auto-recovery...     Ran:   success T�s�e�I   [ L i c e n s e ]   '  A U T O - R E C O V E R Y   S U C C E S S :   L i c e n s e   r e v a l i d a t e d   w i t h   r e c o v e r e d   k e y       (Rh��!>   [License] Server revalidation failed, attempting activation...  RbZ�S�   auto-recovery   T�s*�kJ   [ L i c e n s e ]   '  A U T O - R E C O V E R Y   S U C C E S S :   L i c e n s e   r e - a c t i v a t e d   w i t h   r e c o v e r e d   k e y     RdV1�   [License] Auto-recovery failed: mSb    % @                =`    ��? (�Rd""\-   [License] Auto-recovery error:  Sb    % @                Ra"!ӻ   dbError `    ��? � �@Rb�<k0   SQLITE_BUSY     ,Ri`�QC   [License] Database busy during recovery, will retry on next startup     Rd�@��   [License] Recovery init error:  Sb    % @                �`    ��? �Mp      ����    �� ���k������!�d� ���k ���� ����k�����������k��/��p��d/��^/��X%�/��/�	�f������k ��������k������/�	��
�/���a������k��/���
�/���a������k���/��/�	�f���Ǜ�
�/���a������k���
�/���a�����)�d����k ����	���	�k������/�!��/���a���#���k���/���a���%(��f���'���k ����	���	�k������/�)��/���a���+���k���/���/�-�b����/�*�������� �/�1���/�3�b����5��b��������/�3�/�/�3�/�7��a���9�� �
�/���a���;�� �
�/�1� ��/�3�b����=����k���!�������k��(Sb    �q[                 �`    ����Da    �?      EI  � �f?       ����� � ��� 
����� �       �b   %  MQ    =       Th�`    �   �
�`        ud       �� ($2�@ #B�      �b          y   �      qb           +       \   h�ReKA(   SELECT * FROM license_state WHERE id = 1Sb    % @                �`    ��? (s(      ����    �� ���k������)�d� ���k���� ����k��������/���a������k��������k����������k��Ǉ��������k�� (Sb    �q[                 �`    ����Da    `I      �I  ��a       @     �b     MQ    >       T��`    �   �
�`        $ug    8   �� @,	 0 
d	 0Px	 l$�#@��b          �   �     @qa           �   h�9� C T(�`    
   �
�`        ua       ��(�q`       Raf���    = ?    c              {� ;� �      (Sb    bpW                I`    ����Da    jJ      yJ  (�a              �b     K�    a       Ra��   ,        �2�Rdf��I   UPDATE license_state SET        Rbn��4    WHERE id = 1   Sb    % @                �`    ��? �|@      ����    �� ���k������! �/��a���/��p�����k��! �/��a��	�/�ą �a����/���a����! �/�	�a����/�
���{;��;��b�������k���� ����k���������k��Ň��������k��   (Sb    �q[                �`    ����Da    �I      K  ��c      @ D
��� 
       �b    MQ    ?      � TP�`    [   �
`        uc       �� �4�d      �b          E   +     qa           %   Sb    % @                �`    ��? (m0      ����    �� ���k�����d� ���k���� ����k������������k��Ƈ��������k��     (Sb    �q[                 �`    ����Da    !K      (L  ��a              �b     MQ    @       T	�`    �  �
=`        luy    �   ��� X`��
�
�� 
x� �	P 8��	 �	 �
! ������� �	HG
�	h��	 	<8H
��	 *L�T	�	 x�|LX�����0       �d           �  Q     �   �   �     �q`    -   (�b                     	HRa��   data    FmRd�I��   client missing public key       RaNc�X   envelopeRb�{m�	   signature       Ra�oh�   alg     Ra��܀   ed25519 (�b                     �HUF�CRc�M��   unsupported algorithm:  � �� ��9 @uq4Ra��   verify  (�b                     	HUFmXRt�J�r�   signature verification failed - the license server is signing with a different key than the one embedded in this panel. Re-run the setup script to re-provision.Sb    % @                Rb�'�l   verifyError     `    ��? (p �Rc�L�M   Crypto verify error:     JRa����   ts      �	 �H(�b                     �H�F�Rd���g   invalid envelope timestamp      � fP(�b                     	HUFmCRc��0�   stale response (age=     ��9Ra��-   s)      � �9(�b                     �H�F�Rc*`9�   invalid envelope data   (�b                     �G�C��Sb    % @                =`    ��? (Rd"Nx�   Verification caught error:      (�b                     �H�F�CRc~W�-   verification error:     �              �d� ɛ� )���/�/�/��p�	��
)���{;�6���!�/�	�!
�/��a����/��`���b�����!�/� �a���"�!�/� ��b����$�����/�&��������_��(���*)��0�������� ��/�+���/�-�b����/�!1�/�3��e��5�!7�e��9��;)�!>�/�@�`��B J�= ��<�<�s�D��q�E��r�F�)�G)� �!!I�/�"K�a���M{;�H�#;�H6�O��/�$Q��� �!%S�/�&U�a���W��'Y)��(Z)��6�$[�����)����� ��/�+�*��/�-�b����]�+_)�,��/�-{;�`6�a�  (Sb    �qA                �`    ����Da    hL      kV  �,�ic       �
��8!P @ @ @ @ ����� &P �'Ѐ��� &�&�      �b    @    A       T��`    �   �
�`        4uk    S   ̴ �d��	 � 
�L8�
t��,,�
T	T
��$�|�$X��     �d           �        "   �   Q     Hq`       (�b                     	HUFmRcrZm	   no cached envelope       �� bf�� ��I(�b                     �H�C�CRcv�O&   envelope status:        ��(�b                     �H�C�Rc�-�   machine_id mismatch     (�b                     �G�C��Sb    % @                =`    ��? ((�b                     �H�F�Rd���   cached envelope unreadable      Sb    % @                �`    ��? ��H      ����    ���k������  )���k����!�/��a���$�e���/�	�����k��/��/��p��.�)�/�6��/��/�{;�6�	����k��/��/�
Ɯ!p���)�/�6�����k���)�/�6�����k��Ç�����!)���k��ć��������k��(Sb    �q[                �`    ����Da    �V      Z  ��c"       Ӏ��
��8 � �� ��	 �b  #  MQ    B       T��`    �   �
`         uf    /   �� f�|���p		 	C� <&\ �d                   9   �   k     Pq`       Sb    % @                �`    ��? (@�b                     Rb�_IS   license_key     C�C�CRbN�f�   panel_version   C�CRa:���   nonce   C5��X9 ��9� f�4eE	�=Sb    % @                �`    ��? (zP       ����    ���k��������Ǐć� �������k����� )��6��6��6��6�!	�/��!	�/�
�`�� J� �a���6���/���a����/���a���6� ����k��ć��������k��     (Sb    �qZ                �`    ����Da    NZ      �[  ��c"       ��
 P � P 0  �b    MQ    C       T\�`    w   �
Q`        ue    $   �� 4� TT��|  t�]    �b          a         q`       8Sb    �q[               Ra���%   payload Rb*dԇ	   parsedUrl       a    S       ��? �`    ����Da    �[      �h  (0�b                     	HUF]FmRe�u!   LICENSE_SERVER_URL not configured       @5 T��`    *  �
}`        <um    c   �� �	 �d(�L$-�T	/��	 !�)��($< � '�6 � � 
h 
0     ��q`        8Sb    bpW               �Ra��*U   req     a           ��? I`    ����Da    �\      �h  e �� �@�b                     �CRaJ��   port    CRa@M[   path    CRa�.g�   method  Ran�G=   POST    Ra�
�   headers CRa���E   timeout Cm��RaA�   protocolRa<�3   https:  Raj�,%   pathname �W�(�b                     Rb{u   Content-Type    Rbv�+i   application/jsonRb�%��   Content-Length  CRb2�M
   User-Agent      C]�Rb�8X
   HVM-Panel/      X��T�8<RaV��   request  T@�`    >   �
�`        ud       �� � | � �/     �$q`       8Sb    bpW               RaN��   res     Ua           ��? I`    ����Da    �_      ;f  �IRan)   on      � T(�`       ��`        �b       ��x \    ��`       �c              � �;� %�  (Sb    bpW                I`    ����Da    �_      '`  ��a              �b     K� "   _      RaBab    end      T��`    �   �
	`        4uk    S   Ђd ,
|!����	� 
�|����	 ���	��"� �     �b       6   �   9     @q`       Rb�lݵ
   statusCode      0�b                     	HUF]FmCRb?�W   server error    � �� bf��0�b                     �H�F�F�C �0�b                     �G�C�C�C�Sb    % @                =`    ��? �0�b                     �H�F�F�Rc��S   invalid JSON response   z8              �/�  � �t��$�Ɓ)���/�  {;�6�e�����!	�/����a�����$�e���/���Ł)�/�6�e���!	�/�	�a�����Ł
)�/�6�!�6�#/�6�%e��'�Ň������ā))�e��*��    (Sb    bpW                 I`    ����Da    S`      .f  ��d,       �	� 
� 
`� @ � �&   �b      K� #   `      i(              � �%%%�/� �ƅ �b�����/� �ƅ�b�����  ��a      @     �b     K� !   \      �� T4�`    "   �
a	`        uc       ��h�0�
�       �q`       0�b                     	HUF]FmCRb���T   network error:  ���f               Ɂ  )��/�/�{;�6�e���      (Sb    bpW                I`    ����Da    af      ?g  ��a
       P   �b     K� $   ]       T0�`       �
�	`        uc       ��T ` 
�       �q`       �RaY:{   destroy 0�b                     	HUF]FmRb���A   request timeout e              � �/� �`��Ɂ)�e���    (Sb    bpW                 I`    ����Da    gg      Ch  ��a       0	    �b      K� %   ^      Ra/�   write   	�@              � �%%! �/��� �a���Ɂ�� ��/�6�	� �/��� �/��p�� ��P6�� �/�	�� �/�
;�6��)�!�/��a���6� ���{;�"6�#�6�%��6�'��� �/��p�)�
������/�*Ņ �b����,%�/�.�Å�b����0�/�.�Å�b����2�/�4�a���6�/�8�`��:�      ��e<      @ � 
��� ��`P 0 �"P P @ �b     K�     [      Sb    % @                �`    ��? ep@      ����    � �%���k��%��� �d� ț�)���k��;��� ���l��%!ą ��l�����k��ć��������k�� ��a
      LH   �b    MQ    D      y��	]	�	 T�`    �  �
�	`        �u�      �� b�� 
4p��4�4\	�d
�`_�8
� 
�4Bt�4�4�4� �<���	�  �.��88�
4,
d��	�,T �.��,$X�8$	[
��	�������|����	�.� 
��       �d                    ;   �  3     �qi    4       n       �       �       +      ^      �            �      u  Raޣ|"   web     Sb    % @                �`    ��? (I bZ �b                     ]HmRc�~�@   License key is required.� ��Ip b�0Rjj���K   [License] Same license key already activated on this machine - revalidating     Rb���B   /api/v1/activate	 ��RbBP��   activate failed:� �b                     1CIC� �X� �b                     ]HmCRd��   Could not validate license (    Ra
�L
   ).      U0�b                      ��C�C�C�FRa:襮   invalid  �b                     �H�C]��b    "                  ��I�C�C	CC%C1C=CIFU`        e`        qC}C�C�C�C�C��	%=q}���0Rj���L   License activated successfully (cryptographically verified + hardware bound)     �b                     ]GmRd&�M   License activated successfully! Sb    % @                �`    ��? (��      ����    �� 	���k������	�ȏ���
�������k�������/� �`��ɛ�)���k��#�d����k���� ����k������!�d����k��������k��������k/�	�e/��p��Y�/�	�f�����p��D��/���a���)�d����k��������k�������k���d����k��������k������&�������c�����k��������k������'��f������k��������k�������d��/�����/�!��/�#�b����%"��')��6�(/�#�/�*�� � �b����,6�.e��0���k��������k���쭁2)��/�#{;�3�;�36�4���k��/� 6�/�8�p�:��"��!;)��6�<�6�>/� 6�/�@��"�/�B�� � �b����D6�Fe��H���k��������k���쭁#J)�/� 6�/�K��"6�M���k���/�$P��;�O�e��R�"��%T)��6�&U/� 6�/�'W6�'Y/� 6�/�([6�(]/� 6�/�)_6�)a/� 6�/�*c6�*e�6�g�6�+i�6�,k�6�-m�d�o6�.q�f���s6�u/�$P6�/w�6�0ye��{���k��������k������/��1�a���}�2)���k�����3�������k��    (Sb    �qZ                �`    ����Da    �h      t  �4�k�       0	��
 � � ��
��� � L� '0P � � @ ��� 
����� �`  �b  !  MQ &   E       T��`    �  �
)
`        xu|    �   �� `4\\�|D@��T��4�x_4�4� �<��
��	�  �.��$P�
4,
�8D		[
��	������	��	�.� 
��$�,
h��	� �.� �d	X$  �b          �  #  
   �qg    ,       %       �       �       �       Z            �  (�b                     ]HmRa� ��   no stateU�b                       ��(�b                     �H�Rbz`   no stored key   ��b                       Rb�*P�   /api/v1/validate	p=Rd�Ή~   License validation failed:      �8�b    
                 1CIC ��Rbj�<   deactivated     �F�F� �X�(�b                     ]HmCU�b                       � ��I]h�b                      ����C�C	CC%C1C=CIF�C�C��	%=�� b�8�lrQ�.   '  L i c e n s e   v a l i d a t e d   b y   s e r v e r   -   S t a t u s :   A C T I V E     (�b                     ]GmIUC
8�b    
                  ��C1CIC�F�F ��Rd~Վ�   License deactivated by server:  (�b                     ]HmCUCSb    % @                �`    ��? (��      ����    �� ���k����!�d� ���k���� ����k������������k���/��/�	�f���Ǜ�
	���k���d�
���k��������k������&�/�	�����c�����k��������k������'��f������k��������k�������d��/�����/���/�{;��a���"��)��6�/��/��� � �b���� 6�"e��$���k��������k���&�/�6�'���k��/�)�/�+�p�-���/�/�/�	;�.�e��1�"��3)��6�4/�)�/�66�8/�)�/�:6�</�)�/�>6�@/�)�/�B6�D�6�F�6� H/�/6�!J�6�"Le��N���k��������k������/�#P�$�a���R�%T)�/�)6�U���k��/�)�/�W��&�"��'Y)��6�Z�6�\/�^�� � �b����`6�be��d���k��������k������/�(f�)�b����h�*j)��6�k/�)6�m���k�����+�������k��      (Sb    �q[                 �`    ����Da    -t      ~}  �0�jo       �
��I @  ��� � L
����� 0P � 0� 0� @ ��&0P 0@ 0�      �b   #  MQ '   F       T\�`    x   �
�
`        ud       �� `4\04�H4     �b          b        qa           %   � ��ISb    % @                �`    ��? (p0      ����    �� ���k����!�d� ���k���� ����k�������������k��/�|�/��p����k��Ƈ��������k��(Sb    �q[                 �`    ����Da    �}      �~  ��a       P    �b     MQ (   G       Tt�`    �   �
�
`        ue    '   �� `4\00����4�H0 �b          �   �     $qb           %       g   ��	USb    % @                �`    ��? (v8      ����    �� ���k����!�d� ���k���� ����k�������������k��%�/��/��f������k��������k��������/��/�
����k��Ň��������k��(Sb    �q[                 Rc��   getSignedEnvelope       `    ����Da    �~      �  ��a       P P �b      MQ )   H       Tt�`    �   �
�
`        ue    &   �� `4\0pd
Ll�\3�0  �b          �   �     $qb           %       n   �b                     Rb��	   activated       H���
Sb    % @                �`    ��? (v8      ����    �� ���k����!�d� ���k���� ����k�����������)���k����)�Z�Z�*�d����k����������k������5�����k��Ň��������k�� (Sb    �q[                 �`    ����Da    #�      #�  ��a	       L`  �b     MQ *   I       T,�`       �
`        ub       ܎� �  �q`       p �(Rh�8�>   Background revalidation thread disabled (offline mode removed)  d              � �/� ��a����    (Sb    �qA                 Rd��   startBackgroundRevalidation     `    ����Da    ց      j�  (�a             �b   $  @ +   J       T,�`       �
1`        ub       ԕ &d�     �q`       0Sb    �q@               -`    ��? Rb��]�   requiresLicense `    ����Da    ��      ��  ( T@�`    ;   �M`        �c       �� "p 	4��  ��`       @Sb    �qA               ���b    �       S          I`    ����Da    ܂      ��  A� TL�`    S   �
e`        ue    $   ��p� �
d�, ,
�t D    �q`       - ��Ra�&)�   json     �b                     =Rc��$�   License is not active   mRevy��%   This panel requires an active license   l               �I�� �� ������c�� ��/�� ��a����/�Ɂ)�a���	��d��     (Sb    bpW                I`    ����Da    �      ��  ]�b       @ L        �b     K� .   Y       b| T<�`    8   �
�`        uc       �` �, ,
�� q`       p=Rc���   License check error:     ��u �b                     �Rb�v�   Internal error  mRd�(��   Failed to verify license status h               �� �/� ��b����/�� ��a����/�Ɂ
)�a����(Sb    bpW                I`    ����Da    ��      ��  ]�b       P 0	        �b     K� /   Z      i(               � �%%%�*�d� �/�ǅ �a����/�ȅ�a����     ��a
      @   �b    @ -   X      d              � �%��%� �A�`       �b     @ ,   K      Ia� Td�`    �   �
�`        ub       �� b�4B��d                    ;   m   k     qa           P   �	Sb    % @                �`    ��? (Sb    % @                �`    ��? �r8      ����    �� ���k�������ȏŇ��������k����(�f��� ���k���� ����k����������k��Ň��������k��     (Sb    �qZ                Rd%�   activateWithServerWrapped       `    ����Da    �      g�  ��a              �b  (  MQ 0   L       Tx�`    �   �
�`        ud       �� \T�@ !��@�      �d              �      8   �   �     (qa           x   ISb    % @                �`    ��? ((�b                     �FIC1C �X��Sb    % @                �`    ��? �wH      ����    �� ���k������ɏƇ��������k����"Ɓ )���/��� � �b�����6��d�6�	e�����k���� ����k���������k��Ƈ��������k��      (Sb    �qZ                �`    ����Da    ��      =�  ��b       � �         �b     MQ 1   M       TH�`    N   �
`        ud       ��D �
 � � �      �4q`       Ra�[c�   use     RbnS�   /api/license     Tt�`    �   �9`        �e    #   �� �.� � � , �     �d           �   k        =   �     ,�a    	       (   Sb    % @                =`    ��? (p�Re�ނ%   Failed to initialize license storage:    ��u�b                     �Re��`Z$   License system initialization failed    Sb    % @                �`    ��? �v@       ����    �� ���k�������d� ���k ���� ����k������d�FƇ������ ��/����b����/� ��a��
�/�Ł)�a�������k��Ǉ��������k��     (Sb    bpY                I`    ����Da    ��      ݈  ��b       P @ L     �b     LP 3   T      �RcR��   /api/license/status      Tx�`    �   �
q`        ue    %   �� �4� $� � , �   �d           �   �        G   I     ,qa    	       (   uSb    % @                =`    ��? (p�Rdns�X   Error getting license status:    ���b                     �Rd��&   Failed to get license status    Sb    % @                �`    ��? �wH      ����    �� ���k������+�d� ���k ���� ����k��������/�a���FŇ������ ��/����b����/
� ��a���/�ā)�a�������k��Ƈ��������k��   (Sb    bpY                I`    ����Da    
�      >�  ��b       @ P 0	    �b     LP 4   U      RaN�   post    Rc:N   /api/license/activate    T��`    �   �
�`        ,ui    A   �� ��4
�4����� ,��$� � , �       �d           �   #        �   �     Hqa           9   RaNr*9   body    5}]u �b                     �GmC� �� �b                     �H�CSb    % @                =`    ��? (p�Rd>���   Error activating license:       �b                     �Rd��J�   Failed to activate license      Sb    % @                �`    ��? ��X      ����    �� ���k������/ �/��/��(�f������k ���� ����k������/��/
Á)�/�6�a���)/� ��a���/�Á	)�/�6�a����FÇ�
����� ��/����b���� /� ��a��"�/�$&)�a���'����k��ć��������k��      (Sb    bpY                I`    ����Da    n�      Ɍ  ��d)       P P � � 
`2@ @ L     �b     LP 5   V      Rc�/�   /api/license/deactivate  T��`    �   �
�`         uf    *   �� �;
�.� $� � , �      �d           �   #        T   �     8qa           3   � �u �b                     ]GmRcJƁ>   License deactivated     Sb    % @                =`    ��? (p�Rd��r�   Error deactivating license:      ���b                     �Rd��   Failed to deactivate license    Sb    % @                �`    ��? �yH      ����    �� ���k������/ �/��,�e�����k ���� ����k������/Ł)�a��	�FŇ������ ��/����b����/	� ��a���/�ā
)�a�������k��Ƈ��������k��      (Sb    bpY                I`    ����Da    ��      {�  ��b       @ L
����I �b     LP 6   W      k               /  �ǅ �b���/�ǅ�b���/�ǅ�b���
/�	ǅ
�b����  (Sb    �qA                Rc���T   initLicenseMiddleware   `    ����Da    ��      ��  ��b      P @        �b    @ 2   N      5m��D`    
   �D]Db     @    0      ���)Q}��i�1��9�M�	%
�
�
�
	-��0�48<Rav���   url     @DRa�z#   verbose Ra��Q   sqlite  HRd�@v�   https://license.hvmpanel.xyz     �� ¦Ra~��   V1.0    Ra�w\   hvm.db  ��DRo�E�q   -----BEGIN PUBLIC KEY-----
MCowBQYDK2VwAyEAK+tWEd01AxJy+H+p5kYTT0L81Y+vYHBnC2SnaRyEKeU=
-----END PUBLIC KEY-----
       8�b    
                  b�C ��C=C �CMC b�! ��A�a ���Еb    0                 LC`CRb�-;�   RECHECK_INTERVALCPC�C�C�C�
C�C�C�C�C�C�C�C�C�C�C%CECaC�C-C�CL`YP����
����������%Ea�-� " M�   0           � +�%%%%%%%%	%
%%%%%%%%%� %�%�%�%�%�%�%�%�	%�
	%�
ą%�%�% �%!�%"�%#�%$�%%�%&�%'�%(�%)�%*�Å%+�����%,��� �e�� %�!�e����"�e��%�#�e��%�$�e��%�%�e��
�/�&%�'�e���/�(�`��%�)�e���/�*%	+%
 ,�!,�/�-��I� ��b����% �:%�.%%/�!0�/�1!�/�2#�3%�%%%Ł4%)��56�6&�7 6�8(�9!6�:*�;"6�<,�=#6�>.�%�?0)�
6�@16�A3�6�B56�C76�D9#6�E;*6�F=�6�G?+6�HA!6�IC"6�JE6�KG6�LI$6�MK(6�NM�6�OO)6�PQ,6�QS�6�RU�6�SW�6�TY6�U[�6�V] 6�W_�5Xa�(,�ic   $   @ @ P P  	��
`2� 0� ��������`      �b  	  @    /      b              �   ɮ   Sb    D0                 Ib    ����            Ӑ  �`       �b            .      








// license_client.js - License verification client for HKVM Panel
// Node.js version

'use strict';

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const https = require('https');
const http = require('http');
const { URL } = require('url');
const sqlite3 = require('sqlite3').verbose();
const { open } = require('sqlite');

// ============= CONFIGURATION =============
// All settings hardcoded here - NO external .env changes possible
const LICENSE_SERVER_URL = 'https://license.hvmpanel.xyz';           // License server URL
const RECHECK_INTERVAL = 300;                                  // 5 minutes (seconds)
const MAX_ENVELOPE_AGE = Math.max(RECHECK_INTERVAL * 3, 900); // 15 minutes (seconds)
const HTTP_TIMEOUT = 15000;                                    // 15 seconds (milliseconds)
const NETWORK_GRACE = 3;                                       // Allow 3 network failures
const PANEL_VERSION = 'V1.0';                                  // Panel version
const DEBUG_MODE = false;                                      // Debug logging
const DB_PATH = 'hvm.db';                                      // Database file path

// Embedded Ed25519 public key (PEM format) - MUST match server's public key
// Can be overridden with LICENSE_PUBLIC_KEY environment variable
const EMBEDDED_PUB_KEY_PEM = process.env.LICENSE_PUBLIC_KEY || `-----BEGIN PUBLIC KEY-----
MCowBQYDK2VwAyEAK+tWEd01AxJy+H+p5kYTT0L81Y+vYHBnC2SnaRyEKeU=
-----END PUBLIC KEY-----
`;

// Database path (hardcoded, cannot be changed externally)
let dbPath = DB_PATH;
let db = null;
let publicKeyObj = null;

// Machine ID is derived from hardware - no persistent storage
let cachedMachineId = null;

// Logger utility - uses hardcoded DEBUG_MODE
const logger = {
    info: (...args) => console.log('[INFO]', new Date().toISOString(), ...args),
    warn: (...args) => console.warn('[WARN]', new Date().toISOString(), ...args),
    error: (...args) => console.error('[ERROR]', new Date().toISOString(), ...args),
    debug: (...args) => {
        if (DEBUG_MODE === true) {
            console.debug('[DEBUG]', new Date().toISOString(), ...args);
        }
    },
    exception: (...args) => console.error('[EXCEPTION]', new Date().toISOString(), ...args)
};

// Utility functions
function utcNow() {
    return new Date().toISOString();
}

function sha256(data) {
    return crypto.createHash('sha256').update(data).digest('hex');
}

// ============= HARDWARE-BASED MACHINE ID (NO FILE STORAGE) =============
// Machine ID is derived from actual hardware - recalculated on each startup
// Cannot be bypassed by sharing files - tied to actual machine hardware

async function generateMachineIdFromHardware() {
    try {
        const os = require('os');
        const { exec } = require('child_process');
        const util = require('util');
        const execPromise = util.promisify(exec);

        let hardwareData = '';

        // 1. Hostname
        const hostname = os.hostname();
        hardwareData += `hostname:${hostname}|`;

        // 2. MAC Addresses (all network interfaces)
        const interfaces = os.networkInterfaces();
        const macs = [];
        for (const [name, addrs] of Object.entries(interfaces)) {
            for (const addr of addrs) {
                if (addr.mac && addr.mac !== '00:00:00:00:00:00') {
                    macs.push(addr.mac);
                }
            }
        }
        const sortedMacs = macs.sort().join('|');
        hardwareData += `macs:${sortedMacs}|`;

        // 3. Platform-specific hardware identifiers
        if (process.platform === 'win32') {
            try {
                // Windows: System UUID
                const { stdout: uuid } = await execPromise('wmic csproduct get uuid');
                const systemUuid = uuid.split('\n')[1]?.trim();
                if (systemUuid) hardwareData += `uuid:${systemUuid}|`;

                // Windows: Serial Number
                try {
                    const { stdout: serial } = await execPromise('wmic bios get serialnumber');
                    const serialNum = serial.split('\n')[1]?.trim();
                    if (serialNum) hardwareData += `serial:${serialNum}|`;
                } catch (e) {
                    logger.debug('Could not get BIOS serial:', e.message);
                }

                // Windows: Motherboard Serial
                try {
                    const { stdout: mbserial } = await execPromise('wmic baseboard get serialnumber');
                    const mbSerialNum = mbserial.split('\n')[1]?.trim();
                    if (mbSerialNum) hardwareData += `mb_serial:${mbSerialNum}|`;
                } catch (e) {
                    logger.debug('Could not get MB serial:', e.message);
                }
            } catch (e) {
                logger.debug('Windows hardware detection failed:', e.message);
            }
        } else if (process.platform === 'linux') {
            try {
                // Linux: machine-id
                const machineId = await fs.promises.readFile('/etc/machine-id', 'utf8');
                hardwareData += `machine-id:${machineId.trim()}|`;
            } catch (e) {
                logger.debug('Could not read /etc/machine-id:', e.message);
            }

            try {
                // Linux: DMI serial
                const dmiSerial = await fs.promises.readFile('/sys/class/dmi/id/system-serial-number', 'utf8');
                hardwareData += `dmi_serial:${dmiSerial.trim()}|`;
            } catch (e) {
                logger.debug('Could not read DMI serial:', e.message);
            }
        }

        // 4. CPU info
        const cpus = os.cpus();
        const cpuModel = cpus[0]?.model || 'unknown';
        const cpuCount = cpus.length;
        hardwareData += `cpu:${cpuModel}|cpu_count:${cpuCount}|`;

        // 5. Platform and Architecture
        hardwareData += `platform:${process.platform}|arch:${process.arch}|`;

        // Create SHA256 hash of all hardware data
        const machineId = sha256(hardwareData);
        
        logger.info('[License] Generated machine ID from hardware fingerprint');
        logger.debug('[License] Hardware components:', hardwareData.substring(0, 100) + '...');
        
        return machineId;
    } catch (error) {
        logger.error('[License] Hardware fingerprinting failed:', error.message);
        // Fallback: generate a temporary ID (should not happen in normal operation)
        const { v4: uuidv4 } = require('uuid');
        return uuidv4();
    }
}

// Hardware Fingerprinting - ULTRA-SECURE BINDING
async function generateHardwareFingerprint() {
    try {
        const os = require('os');
        const { exec } = require('child_process');
        const util = require('util');
        const execPromise = util.promisify(exec);

        let fingerprint = '';

        // Get hostname
        fingerprint += `hostname:${os.hostname()}`;

        // Get all network interfaces and MAC addresses
        const interfaces = os.networkInterfaces();
        const macs = [];
        for (const [name, addrs] of Object.entries(interfaces)) {
            for (const addr of addrs) {
                if (addr.mac && addr.mac !== '00:00:00:00:00:00') {
                    macs.push(addr.mac);
                }
            }
        }
        fingerprint += `|macs:${macs.sort().join(',')}`;

        // Get platform-specific hardware info
        if (process.platform === 'win32') {
            try {
                // Windows: Get system UUID from WMI
                const { stdout } = await execPromise('wmic csproduct get uuid');
                const uuid = stdout.split('\n')[1]?.trim();
                if (uuid) fingerprint += `|uuid:${uuid}`;
            } catch (e) {
                logger.debug('Could not get Windows UUID:', e.message);
            }
        } else if (process.platform === 'linux') {
            try {
                // Linux: Get machine-id
                const machineId = await fs.promises.readFile('/etc/machine-id', 'utf8');
                fingerprint += `|machine-id:${machineId.trim()}`;
            } catch (e) {
                logger.debug('Could not read /etc/machine-id:', e.message);
            }
        }

        // Hash the fingerprint for consistent format
        return sha256(fingerprint);
    } catch (error) {
        logger.warn('Hardware fingerprinting failed:', error.message);
        return null; // Fallback - server will handle
    }
}

function xorBytes(data, key) {
    if (!key || key.length === 0) return data;
    const result = Buffer.alloc(data.length);
    for (let i = 0; i < data.length; i++) {
        result[i] = data[i] ^ key[i % key.length];
    }
    return result;
}

function keyForMachine(machineId, salt) {
    return crypto.createHash('sha256')
        .update(Buffer.concat([
            Buffer.from('license::' + machineId),
            salt
        ]))
        .digest();
}

function encryptKey(plain, machineId) {
    const salt = crypto.randomBytes(16);
    const blob = xorBytes(Buffer.from(plain, 'utf8'), keyForMachine(machineId, salt));
    return Buffer.concat([salt, blob]).toString('base64');
}

function decryptKey(blobB64, machineId) {
    if (!blobB64) return null;
    try {
        const raw = Buffer.from(blobB64, 'base64');
        const salt = raw.slice(0, 16);
        const blob = raw.slice(16);
        return xorBytes(blob, keyForMachine(machineId, salt)).toString('utf8');
    } catch (error) {
        return null;
    }
}

// Public key loading
function resolvePubKeyPem() {
    // Priority 1: Environment variable LICENSE_PUBLIC_KEY (most secure)
    const envPem = (process.env.LICENSE_PUBLIC_KEY || '').trim();
    if (envPem && envPem.length > 50) {
        return envPem;
    }
    
    // Priority 2: Environment variable pointing to file
    const envFile = (process.env.LICENSE_PUBLIC_KEY_FILE || '').trim();
    if (envFile && fs.existsSync(envFile)) {
        try {
            return fs.readFileSync(envFile, 'utf8').trim();
        } catch (error) {
            logger.warn('Could not read LICENSE_PUBLIC_KEY_FILE:', error.message);
        }
    }
    
    // Priority 3: Embedded key
    let pem = EMBEDDED_PUB_KEY_PEM;
    if (!pem || pem.includes('REPLACE_WITH_YOUR_PUBLIC_KEY_PEM_BLOCK')) {
        logger.error('License public key is not configured. Set LICENSE_PUBLIC_KEY environment variable or LICENSE_PUBLIC_KEY_FILE.');
        return null;
    }
    
    return pem;
}

function loadPublicKey() {
    if (publicKeyObj) return publicKeyObj;
    const pem = resolvePubKeyPem();
    if (!pem || pem.includes('REPLACE_WITH_YOUR_PUBLIC_KEY_PEM_BLOCK')) {
        logger.error('License public key is not configured. Run the setup script to provision this panel.');
        return null;
    }
    try {
        // For Ed25519, we need to use the PEM format directly with crypto.verify()
        // Node.js crypto.verify() handles Ed25519 PEM keys correctly
        publicKeyObj = pem;
        return publicKeyObj;
    } catch (error) {
        logger.error('Failed to load license public key:', error.message);
        return null;
    }
}

function getPublicKeyFingerprint() {
    const pem = resolvePubKeyPem();
    const normalized = pem.split('\n')
        .map(line => line.trim())
        .filter(line => line.length > 0)
        .join('\n');
    return sha256(Buffer.from(normalized));
}

function getServerUrl() {
    return LICENSE_SERVER_URL.replace(/\/$/, '');
}

// Database initialization
async function initLicenseStorage(customDbPath = null, sharedDb = null) {
    if (customDbPath) {
        dbPath = customDbPath;
    }
    
    // If a shared database connection is provided, use it
    if (sharedDb) {
        db = sharedDb;
    } else {
        db = await open({
            filename: dbPath,
            driver: sqlite3.Database
        });
    }
    
    // Enable WAL mode to reduce locking conflicts
    try {
        await db.exec('PRAGMA journal_mode = WAL');
        await db.exec('PRAGMA busy_timeout = 5000');
    } catch (e) {
        logger.debug('Could not set WAL mode:', e.message);
    }
    
    await db.exec(`
        CREATE TABLE IF NOT EXISTS license_state (
            id INTEGER PRIMARY KEY CHECK (id = 1),
            machine_id TEXT,
            hardware_fingerprint TEXT,
            status TEXT,
            usage_type TEXT,
            max_activations INTEGER,
            owner TEXT,
            expires_at TEXT,
            last_check_at TEXT,
            last_success_at TEXT,
            last_error TEXT,
            failure_count INTEGER NOT NULL DEFAULT 0,
            activation_failures INTEGER NOT NULL DEFAULT 0,
            activated_at TEXT,
            activated_by TEXT,
            server_url TEXT,
            key_blob TEXT,
            cached_envelope TEXT,
            cache_integrity_check TEXT
        )
    `);
    
    // Migrations for older deployments
    const columns = [
        ['machine_id', 'TEXT'],
        ['hardware_fingerprint', 'TEXT'],
        ['status', 'TEXT'],
        ['usage_type', 'TEXT'],
        ['max_activations', 'INTEGER'],
        ['owner', 'TEXT'],
        ['expires_at', 'TEXT'],
        ['last_check_at', 'TEXT'],
        ['last_success_at', 'TEXT'],
        ['last_error', 'TEXT'],
        ['failure_count', 'INTEGER NOT NULL DEFAULT 0'],
        ['activation_failures', 'INTEGER NOT NULL DEFAULT 0'],
        ['activated_at', 'TEXT'],
        ['activated_by', 'TEXT'],
        ['server_url', 'TEXT'],
        ['key_blob', 'TEXT'],
        ['cached_envelope', 'TEXT'],
        ['cache_integrity_check', 'TEXT']
    ];
    
    for (const [col, ddl] of columns) {
        try {
            await db.exec(`ALTER TABLE license_state ADD COLUMN ${col} ${ddl}`);
        } catch (error) {
            // Column already exists, ignore
        }
    }
    
    const count = await db.get('SELECT COUNT(*) as cnt FROM license_state');
    if (count.cnt === 0) {
        await db.run('INS