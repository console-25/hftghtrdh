#!/usr/bin/env python3
"""
HVM Panel - Node Agent
Version: 2.0-PRO-ULTIMATE
Developer: Hopingboz
Description: Enhanced LXC Container Management Node Agent
"""

import argparse
import json
import os
import re
import shlex
import shutil
import socket
import subprocess
import sys
import signal
from datetime import datetime
from typing import Dict, Any, Optional, List
from flask import Flask, request, jsonify, abort
import logging
import threading
import time
from functools import wraps

# ASCII Art Banner
BANNER = """
╔═══════════════════════════════════════════════════════════════════════════╗
║                                                                           ║
║   ██╗  ██╗██╗   ██╗███╗   ███╗    ███╗   ██╗ ██████╗ ██████╗ ███████╗   ║
║   ██║  ██║██║   ██║████╗ ████║    ████╗  ██║██╔═══██╗██╔══██╗██╔════╝   ║
║   ███████║██║   ██║██╔████╔██║    ██╔██╗ ██║██║   ██║██║  ██║█████╗     ║
║   ██╔══██║╚██╗ ██╔╝██║╚██╔╝██║    ██║╚██╗██║██║   ██║██║  ██║██╔══╝     ║
║   ██║  ██║ ╚████╔╝ ██║ ╚═╝ ██║    ██║ ╚████║╚██████╔╝██████╔╝███████╗   ║
║   ╚═╝  ╚═╝  ╚═══╝  ╚═╝     ╚═╝    ╚═╝  ╚═══╝ ╚═════╝ ╚═════╝ ╚══════╝   ║
║                                                                           ║
║                    Node Agent - Version 2.0-PRO-ULTIMATE                 ║
║                    LXC Container Management Agent                        ║
║                                                                           ║
╚═══════════════════════════════════════════════════════════════════════════╝
"""

# Version info
VERSION = "2.0-PRO-ULTIMATE"
DEVELOPER = "Hopingboz"

# Print banner on startup
print(BANNER)
print(f"  Version: {VERSION}")
print(f"  Developer: {DEVELOPER}")
print(f"  Python: {sys.version.split()[0]}")
print("=" * 79 + "\n")

# Manual .env loader (no external deps)
def load_env(file_path='.env') -> Dict[str, str]:
    """Load environment variables from .env file"""
    config = {}
    if os.path.exists(file_path):
        try:
            with open(file_path, 'r', encoding='utf-8') as f:
                for line_num, line in enumerate(f, 1):
                    line = line.strip()
                    if line and not line.startswith('#'):
                        if '=' in line:
                            key, value = line.split('=', 1)
                            # Strip quotes if present
                            value = value.strip().strip('"\'')
                            config[key.strip()] = value
                        else:
                            logging.warning(f"Invalid .env line {line_num}: {line}")
        except Exception as e:
            logging.error(f"Failed to load .env: {e}")
    return config

# Configure logging
def setup_logging(log_level: str = 'INFO', log_file: str = 'node-agent.log'):
    """Setup logging configuration"""
    level = getattr(logging, log_level.upper(), logging.INFO)
    
    # Create formatter
    formatter = logging.Formatter(
        '%(asctime)s - %(name)s - %(levelname)s - %(message)s',
        datefmt='%Y-%m-%d %H:%M:%S'
    )
    
    # File handler
    file_handler = logging.FileHandler(log_file)
    file_handler.setLevel(level)
    file_handler.setFormatter(formatter)
    
    # Console handler
    console_handler = logging.StreamHandler(sys.stdout)
    console_handler.setLevel(level)
    console_handler.setFormatter(formatter)
    
    # Configure root logger
    root_logger = logging.getLogger()
    root_logger.setLevel(level)
    root_logger.handlers = []  # Clear existing handlers
    root_logger.addHandler(file_handler)
    root_logger.addHandler(console_handler)

logger = logging.getLogger('node-agent')

app = Flask(__name__)
app.config['JSON_SORT_KEYS'] = False

# Global config
API_KEY: Optional[str] = None
HOST: str = '0.0.0.0'
PORT: int = 5000
HEALTH_MONITOR_INTERVAL: int = 60

# Graceful shutdown handler
shutdown_event = threading.Event()

def signal_handler(signum, frame):
    """Handle shutdown signals gracefully"""
    logger.info(f"Received signal {signum}, shutting down gracefully...")
    shutdown_event.set()
    sys.exit(0)

signal.signal(signal.SIGINT, signal_handler)
signal.signal(signal.SIGTERM, signal_handler)

# Authentication decorator
def require_api_key(f):
    """Decorator to require API key authentication"""
    @wraps(f)
    def decorated_function(*args, **kwargs):
        api_key = request.headers.get('X-API-Key') or request.args.get('api_key')
        if not api_key or api_key != API_KEY:
            logger.warning(f"Unauthorized access attempt from {request.remote_addr}")
            abort(401, description="Unauthorized: Invalid or missing API key")
        return f(*args, **kwargs)
    return decorated_function

# LXC command execution with enhanced error handling
def execute_lxc(full_command: str, timeout: int = 120) -> Dict[str, Any]:
    """Execute LXC command with proper error handling and timeout"""
    logger.info(f"Executing: {full_command}")
    
    try:
        cmd = shlex.split(full_command)
        
        proc = subprocess.Popen(
            cmd,
            stdout=subprocess.PIPE,
            stderr=subprocess.PIPE,
            universal_newlines=True,
            preexec_fn=os.setsid if hasattr(os, 'setsid') else None
        )
        
        try:
            stdout, stderr = proc.communicate(timeout=timeout)
            stdout = stdout.strip() if stdout else ""
            stderr = stderr.strip() if stderr else ""
            
            result = {
                "success": proc.returncode == 0,
                "returncode": proc.returncode,
                "stdout": stdout,
                "stderr": stderr,
                "command": full_command
            }
            
            if proc.returncode == 0:
                logger.info(f"Command succeeded: {full_command}")
            else:
                logger.warning(f"Command failed (rc={proc.returncode}): {full_command}")
                if stderr:
                    logger.warning(f"Error output: {stderr}")
            
            return result
            
        except subprocess.TimeoutExpired:
            proc.kill()
            proc.wait()
            logger.error(f"Command timed out after {timeout}s: {full_command}")
            return {
                "success": False,
                "returncode": 124,
                "stdout": "",
                "stderr": f"Command timed out after {timeout} seconds",
                "command": full_command
            }
            
    except FileNotFoundError as e:
        logger.error(f"Command not found: {full_command} - {str(e)}")
        return {
            "success": False,
            "returncode": 127,
            "stdout": "",
            "stderr": f"Command not found: {str(e)}",
            "command": full_command
        }
    except Exception as e:
        logger.error(f"Execution error: {full_command} - {str(e)}")
        return {
            "success": False,
            "returncode": 1,
            "stdout": "",
            "stderr": str(e),
            "command": full_command
        }

# Host resource monitoring functions
def get_host_cpu_usage() -> float:
    """Get host CPU usage percentage with multiple fallback methods"""
    try:
        # Method 1: Try mpstat (most accurate)
        if shutil.which("mpstat"):
            try:
                result = subprocess.run(
                    ['mpstat', '1', '1'],
                    capture_output=True,
                    text=True,
                    timeout=10
                )
                if result.returncode == 0:
                    for line in result.stdout.split('\n'):
                        if 'all' in line.lower() or 'Average' in line:
                            parts = line.split()
                            # Last column is usually idle
                            try:
                                idle = float(parts[-1].replace(',', '.'))
                                return round(100.0 - idle, 2)
                            except (ValueError, IndexError):
                                continue
            except subprocess.TimeoutExpired:
                logger.warning("mpstat command timed out")
        
        # Method 2: Try top command
        if shutil.which("top"):
            try:
                result = subprocess.run(
                    ['top', '-bn1'],
                    capture_output=True,
                    text=True,
                    timeout=5
                )
                if result.returncode == 0:
                    for line in result.stdout.split('\n'):
                        if '%Cpu' in line or 'CPU' in line:
                            # Extract idle percentage
                            match = re.search(r'(\d+\.?\d*)\s*id', line)
                            if match:
                                idle = float(match.group(1))
                                return round(100.0 - idle, 2)
            except subprocess.TimeoutExpired:
                logger.warning("top command timed out")
        
        # Method 3: Fallback to /proc/stat (basic but reliable)
        if os.path.exists('/proc/stat'):
            with open('/proc/stat', 'r') as f:
                line = f.readline()
                if line.startswith('cpu '):
                    fields = line.split()[1:]
                    if len(fields) >= 4:
                        total = sum(int(x) for x in fields)
                        idle = int(fields[3])
                        if total > 0:
                            return round((1 - idle / total) * 100, 2)
        
        logger.warning("All CPU usage detection methods failed")
        return 0.0
        
    except Exception as e:
        logger.error(f"Error getting CPU usage: {e}")
        return 0.0

def get_host_ram_usage() -> Dict[str, Any]:
    """Get host RAM usage with detailed info and multiple fallback methods"""
    try:
        # Method 1: Try free command
        if shutil.which("free"):
            result = subprocess.run(
                ['free', '-m'],
                capture_output=True,
                text=True,
                timeout=5
            )
            
            if result.returncode == 0:
                lines = result.stdout.splitlines()
                if len(lines) > 1:
                    mem = lines[1].split()
                    if len(mem) >= 3:
                        total = int(mem[1])
                        used = int(mem[2])
                        free = int(mem[3]) if len(mem) > 3 else 0
                        available = int(mem[6]) if len(mem) > 6 else free
                        percent = round((used / total * 100), 2) if total > 0 else 0.0
                        
                        return {
                            'total': total,
                            'used': used,
                            'free': free,
                            'available': available,
                            'percent': percent
                        }
        
        # Method 2: Fallback to /proc/meminfo
        if os.path.exists('/proc/meminfo'):
            meminfo = {}
            with open('/proc/meminfo', 'r') as f:
                for line in f:
                    parts = line.split(':')
                    if len(parts) == 2:
                        key = parts[0].strip()
                        value = parts[1].strip().split()[0]
                        meminfo[key] = int(value) // 1024  # Convert to MB
            
            if 'MemTotal' in meminfo and 'MemAvailable' in meminfo:
                total = meminfo['MemTotal']
                available = meminfo['MemAvailable']
                used = total - available
                free = meminfo.get('MemFree', 0)
                percent = round((used / total * 100), 2) if total > 0 else 0.0
                
                return {
                    'total': total,
                    'used': used,
                    'free': free,
                    'available': available,
                    'percent': percent
                }
        
        logger.warning("All RAM usage detection methods failed")
        return {'total': 0, 'used': 0, 'free': 0, 'available': 0, 'percent': 0.0}
        
    except Exception as e:
        logger.error(f"Error getting RAM usage: {e}")
        return {'total': 0, 'used': 0, 'free': 0, 'available': 0, 'percent': 0.0}

def get_host_disk_usage() -> Dict[str, Any]:
    """Get host disk usage with detailed info"""
    try:
        result = subprocess.run(
            ['df', '-h', '/'],
            capture_output=True,
            text=True,
            timeout=5
        )
        
        if result.returncode == 0:
            lines = result.stdout.splitlines()
            if len(lines) > 1:
                parts = lines[1].split()
                if len(parts) >= 5:
                    return {
                        'total': parts[1],
                        'used': parts[2],
                        'free': parts[3],
                        'percent': parts[4]
                    }
        
        return {'total': 'Unknown', 'used': 'Unknown', 'free': 'Unknown', 'percent': '0%'}
        
    except Exception as e:
        logger.error(f"Error getting disk usage: {e}")
        return {'total': 'Unknown', 'used': 'Unknown', 'free': 'Unknown', 'percent': '0%'}

def get_host_uptime() -> str:
    """Get host uptime"""
    try:
        with open('/proc/uptime', 'r') as f:
            uptime_seconds = float(f.readline().split()[0])
            days = int(uptime_seconds // 86400)
            hours = int((uptime_seconds % 86400) // 3600)
            minutes = int((uptime_seconds % 3600) // 60)
            return f"{days}d {hours}h {minutes}m"
    except Exception as e:
        logger.error(f"Error getting uptime: {e}")
        return "Unknown"

def get_host_stats() -> Dict[str, Any]:
    """Get comprehensive host statistics"""
    return {
        "cpu": get_host_cpu_usage(),
        "ram": get_host_ram_usage(),
        "disk": get_host_disk_usage(),
        "uptime": get_host_uptime(),
        "timestamp": datetime.now().isoformat()
    }

# Container management functions
def get_container_status(container_name: str) -> str:
    """Get container status with enhanced detection"""
    try:
        # Method 1: Try lxc info (most reliable)
        result = subprocess.run(
            ["lxc", "info", container_name],
            capture_output=True,
            text=True,
            timeout=10
        )
        
        if result.returncode == 0:
            for line in result.stdout.splitlines():
                if line.startswith("Status:"):
                    status = line.split(":", 1)[1].strip().lower()
                    return status
        
        # Method 2: Try lxc-info as fallback
        if shutil.which("lxc-info"):
            result = subprocess.run(
                ["lxc-info", "-n", container_name, "-s"],
                capture_output=True,
                text=True,
                timeout=10
            )
            
            if result.returncode == 0:
                for line in result.stdout.splitlines():
                    if "State:" in line:
                        status = line.split(":", 1)[1].strip().lower()
                        return status
        
        # Method 3: Check if container exists
        result = subprocess.run(
            ["lxc", "list", container_name, "--format", "json"],
            capture_output=True,
            text=True,
            timeout=10
        )
        
        if result.returncode == 0:
            try:
                data = json.loads(result.stdout)
                if data and len(data) > 0:
                    return data[0].get('status', 'unknown').lower()
            except json.JSONDecodeError:
                pass
        
        logger.warning(f"Could not determine status for container: {container_name}")
        return "unknown"
        
    except subprocess.TimeoutExpired:
        logger.error(f"Timeout getting container status for {container_name}")
        return "timeout"
    except Exception as e:
        logger.error(f"Error getting container status for {container_name}: {e}")
        return "error"

def get_container_cpu(container_name: str) -> float:
    """Get container CPU usage - simplified and reliable"""
    try:
        status = get_container_status(container_name)
        if status != "running":
            return 0.0
        
        # Method 1: Simple sh with awk (most compatible)
        try:
            simple_script = r"""sh -c '
cat /proc/stat | grep "^cpu " > /tmp/cpu1
sleep 1
cat /proc/stat | grep "^cpu " > /tmp/cpu2
awk "{
    getline < \"/tmp/cpu1\"
    u1=\$2; n1=\$3; s1=\$4; i1=\$5
    getline < \"/tmp/cpu2\"
    u2=\$2; n2=\$3; s2=\$4; i2=\$5
    total=(u2-u1)+(n2-n1)+(s2-s1)+(i2-i1)
    used=(u2-u1)+(n2-n1)+(s2-s1)
    if(total>0) print (used*100)/total; else print 0
}" /tmp/cpu2
rm -f /tmp/cpu1 /tmp/cpu2
'"""
            result = subprocess.run(
                ["lxc", "exec", container_name, "--"] + simple_script.split(),
                capture_output=True,
                text=True,
                timeout=5
            )
            
            if result.returncode == 0:
                cpu_pct = float(result.stdout.strip())
                if 0 <= cpu_pct <= 100:
                    return round(cpu_pct, 2)
        except Exception as e:
            logger.debug(f"Simple sh method failed for {container_name}: {e}")
        
        # Method 2: Use top command
        try:
            result = subprocess.run(
                ["lxc", "exec", container_name, "--", "sh", "-c", "top -bn1 | grep 'Cpu(s)'"],
                capture_output=True,
                text=True,
                timeout=5
            )
            
            if result.returncode == 0 and result.stdout:
                import re
                idle_match = re.search(r'(\d+\.?\d*)\s*id', result.stdout)
                if idle_match:
                    idle = float(idle_match.group(1))
                    return round(100.0 - idle, 2)
        except Exception as e:
            logger.debug(f"Top method failed for {container_name}: {e}")
        
        # Method 3: Direct /proc/stat with sleep
        try:
            result = subprocess.run(
                ["lxc", "exec", container_name, "--", "sh", "-c", 
                 "grep '^cpu ' /proc/stat && sleep 1 && grep '^cpu ' /proc/stat"],
                capture_output=True,
                text=True,
                timeout=5
            )
            
            if result.returncode == 0:
                lines = [line for line in result.stdout.split('\n') if line.startswith('cpu ')]
                if len(lines) >= 2:
                    fields1 = [int(x) for x in lines[0].split()[1:8]]
                    total1 = sum(fields1)
                    idle1 = fields1[3]
                    
                    fields2 = [int(x) for x in lines[1].split()[1:8]]
                    total2 = sum(fields2)
                    idle2 = fields2[3]
                    
                    total_delta = total2 - total1
                    idle_delta = idle2 - idle1
                    
                    if total_delta > 0:
                        cpu_pct = 100.0 * (total_delta - idle_delta) / total_delta
                        return round(cpu_pct, 2)
        except Exception as e:
            logger.debug(f"/proc/stat method failed for {container_name}: {e}")
        
        logger.warning(f"All CPU methods failed for {container_name}, returning 0")
        return 0.0
        
    except Exception as e:
        logger.error(f"Error getting CPU for {container_name}: {e}")
        return 0.0

def get_container_ram(container_name: str) -> Dict[str, Any]:
    """Get container RAM usage"""
    try:
        status = get_container_status(container_name)
        if status != "running":
            return {'used': 0, 'total': 0, 'percent': 0.0}
        
        result = subprocess.run(
            ["lxc", "exec", container_name, "--", "free", "-m"],
            capture_output=True,
            text=True,
            timeout=10
        )
        
        if result.returncode == 0:
            lines = result.stdout.splitlines()
            if len(lines) > 1:
                parts = lines[1].split()
                if len(parts) >= 3:
                    total = int(parts[1])
                    used = int(parts[2])
                    percent = round((used / total * 100), 2) if total > 0 else 0.0
                    return {'used': used, 'total': total, 'percent': percent}
        
        return {'used': 0, 'total': 0, 'percent': 0.0}
        
    except Exception as e:
        logger.error(f"Error getting RAM for {container_name}: {e}")
        return {'used': 0, 'total': 0, 'percent': 0.0}

def get_container_disk(container_name: str) -> str:
    """Get container disk usage"""
    try:
        status = get_container_status(container_name)
        if status != "running":
            return "Stopped"
        
        result = subprocess.run(
            ["lxc", "exec", container_name, "--", "df", "-h", "/"],
            capture_output=True,
            text=True,
            timeout=10
        )
        
        if result.returncode == 0:
            lines = result.stdout.splitlines()
            for line in lines[1:]:
                parts = line.split()
                if len(parts) >= 5:
                    return f"{parts[2]}/{parts[1]} ({parts[4]})"
        
        return "Unknown"
        
    except Exception:
        return "Unknown"

def get_container_uptime(container_name: str) -> str:
    """Get container uptime"""
    try:
        status = get_container_status(container_name)
        if status != "running":
            return "Stopped"
        
        result = subprocess.run(
            ["lxc", "exec", container_name, "--", "cat", "/proc/uptime"],
            capture_output=True,
            text=True,
            timeout=10
        )
        
        if result.returncode == 0:
            uptime_seconds = float(result.stdout.split()[0])
            days = int(uptime_seconds // 86400)
            hours = int((uptime_seconds % 86400) // 3600)
            minutes = int((uptime_seconds % 3600) // 60)
            return f"{days}d {hours}h {minutes}m"
        
        return "Unknown"
        
    except Exception:
        return "Unknown"

def get_container_stats(container_name: str) -> Dict[str, Any]:
    """Get comprehensive container statistics"""
    return {
        "status": get_container_status(container_name),
        "cpu": get_container_cpu(container_name),
        "ram": get_container_ram(container_name),
        "disk": get_container_disk(container_name),
        "uptime": get_container_uptime(container_name),
        "timestamp": datetime.now().isoformat()
    }

def list_containers() -> List[str]:
    """List all containers with multiple detection methods"""
    try:
        containers = []
        
        # Method 1: Try lxc list (preferred)
        if shutil.which("lxc"):
            result = subprocess.run(
                ["lxc", "list", "--format", "json"],
                capture_output=True,
                text=True,
                timeout=10
            )
            
            if result.returncode == 0:
                try:
                    data = json.loads(result.stdout)
                    containers = [c['name'] for c in data if 'name' in c]
                    if containers:
                        return containers
                except json.JSONDecodeError:
                    logger.warning("Failed to parse lxc list JSON output")
        
        # Method 2: Try lxc-ls
        if shutil.which("lxc-ls"):
            result = subprocess.run(
                ["lxc-ls", "-1"],
                capture_output=True,
                text=True,
                timeout=10
            )
            
            if result.returncode == 0:
                containers = [c.strip() for c in result.stdout.splitlines() if c.strip()]
                if containers:
                    return containers
        
        # Method 3: Check /var/lib/lxc directory
        lxc_path = "/var/lib/lxc"
        if os.path.exists(lxc_path) and os.path.isdir(lxc_path):
            try:
                containers = [d for d in os.listdir(lxc_path) 
                            if os.path.isdir(os.path.join(lxc_path, d))]
                if containers:
                    return containers
            except PermissionError:
                logger.warning(f"Permission denied accessing {lxc_path}")
        
        logger.warning("No containers found or all detection methods failed")
        return []
        
    except subprocess.TimeoutExpired:
        logger.error("Timeout listing containers")
        return []
    except Exception as e:
        logger.error(f"Error listing containers: {e}")
        return []

def container_action(container: str, action: str, timeout: int = 60) -> Dict[str, Any]:
    """Perform action on container (start/stop/restart) with detailed response"""
    try:
        # Validate action
        valid_actions = ['start', 'stop', 'restart', 'freeze', 'unfreeze']
        if action not in valid_actions:
            logger.error(f"Invalid action: {action}")
            return {
                "success": False,
                "error": f"Invalid action. Must be one of: {', '.join(valid_actions)}",
                "container": container,
                "action": action
            }
        
        # Check if container exists
        status_before = get_container_status(container)
        if status_before in ['unknown', 'error']:
            logger.warning(f"Container may not exist: {container}")
            return {
                "success": False,
                "error": f"Container not found or inaccessible: {container}",
                "container": container,
                "action": action
            }
        
        # Perform action
        cmd = ["lxc", action, container]
        logger.info(f"Executing: {' '.join(cmd)}")
        
        result = subprocess.run(
            cmd,
            capture_output=True,
            text=True,
            timeout=timeout
        )
        
        success = result.returncode == 0
        
        # Get status after action
        time.sleep(1)  # Brief wait for status to update
        status_after = get_container_status(container)
        
        response = {
            "success": success,
            "container": container,
            "action": action,
            "status_before": status_before,
            "status_after": status_after,
            "returncode": result.returncode,
            "stdout": result.stdout.strip() if result.stdout else "",
            "stderr": result.stderr.strip() if result.stderr else ""
        }
        
        if success:
            logger.info(f"Container {action} successful: {container} ({status_before} -> {status_after})")
        else:
            logger.warning(f"Container {action} failed: {container} - {result.stderr}")
            response["error"] = result.stderr.strip() if result.stderr else "Unknown error"
        
        return response
        
    except subprocess.TimeoutExpired:
        logger.error(f"Container {action} timed out after {timeout}s: {container}")
        return {
            "success": False,
            "error": f"Operation timed out after {timeout} seconds",
            "container": container,
            "action": action,
            "timeout": timeout
        }
    except Exception as e:
        logger.error(f"Error in container {action}: {container} - {e}")
        return {
            "success": False,
            "error": str(e),
            "container": container,
            "action": action
        }

# API Endpoints
@app.route('/api/health', methods=['GET'])
def api_health():
    """Public health check endpoint (no authentication required)"""
    return jsonify({
        "status": "ok",
        "service": "HVM Node Agent",
        "version": VERSION,
        "hostname": socket.gethostname(),
        "timestamp": datetime.now().isoformat()
    }), 200

@app.route('/api/test-connection', methods=['POST'])
def api_test_connection():
    """Test connection from HVM Panel - validates API key and returns node info"""
    try:
        # Get API key from request
        api_key = request.headers.get('X-API-Key') or request.args.get('api_key')
        
        # Validate API key
        if not api_key or api_key != API_KEY:
            logger.warning(f"Connection test failed: Invalid API key from {request.remote_addr}")
            return jsonify({
                "success": False,
                "error": "Invalid or missing API key",
                "authenticated": False
            }), 401
        
        # Get comprehensive node information
        host_stats = get_host_stats()
        containers = list_containers()
        
        # Get LXC version
        lxc_version = "Unknown"
        lxc_available = shutil.which("lxc") is not None
        if lxc_available:
            try:
                result = subprocess.run(
                    ["lxc", "version"],
                    capture_output=True,
                    text=True,
                    timeout=5
                )
                if result.returncode == 0:
                    lxc_version = result.stdout.strip()
            except:
                pass
        
        # Build response
        response = {
            "success": True,
            "authenticated": True,
            "message": "Connection test successful",
            "node_info": {
                "hostname": socket.gethostname(),
                "version": VERSION,
                "lxc_version": lxc_version,
                "lxc_available": lxc_available,
                "python_version": sys.version.split()[0],
                "uptime": get_host_uptime()
            },
            "resources": {
                "cpu_usage": host_stats['cpu'],
                "ram": host_stats['ram'],
                "disk": host_stats['disk']
            },
            "containers": {
                "total": len(containers),
                "list": containers[:10]  # First 10 containers
            },
            "timestamp": datetime.now().isoformat()
        }
        
        logger.info(f"Connection test successful from {request.remote_addr}")
        return jsonify(response), 200
        
    except Exception as e:
        logger.error(f"Connection test error: {str(e)}")
        return jsonify({
            "success": False,
            "error": str(e),
            "authenticated": True
        }), 500

@app.route('/api/ping', methods=['GET'])
@require_api_key
def api_ping():
    """Enhanced health check endpoint with detailed status"""
    try:
        # Quick health metrics
        cpu = get_host_cpu_usage()
        ram = get_host_ram_usage()
        containers = list_containers()
        
        # Determine health status
        health_status = "healthy"
        warnings = []
        
        if cpu > 90:
            health_status = "warning"
            warnings.append(f"High CPU usage: {cpu}%")
        
        if ram['percent'] > 90:
            health_status = "warning"
            warnings.append(f"High RAM usage: {ram['percent']}%")
        
        return jsonify({
            "status": "ok",
            "health": health_status,
            "version": VERSION,
            "hostname": socket.gethostname(),
            "uptime": get_host_uptime(),
            "quick_stats": {
                "cpu": cpu,
                "ram_percent": ram['percent'],
                "container_count": len(containers)
            },
            "warnings": warnings,
            "timestamp": datetime.now().isoformat()
        }), 200
        
    except Exception as e:
        logger.error(f"Ping error: {str(e)}")
        return jsonify({
            "status": "error",
            "error": str(e),
            "timestamp": datetime.now().isoformat()
        }), 500

@app.route('/api/execute', methods=['POST'])
@require_api_key
def api_execute():
    """Execute LXC command"""
    try:
        data = request.get_json()
        if not data or 'command' not in data:
            logger.error("Execute API: Missing 'command' in request body")
            return jsonify({"error": "Missing 'command' in request body"}), 400
        
        full_command = data['command']
        timeout = data.get('timeout', 120)
        
        logger.info(f"Execute API: Received command: {full_command}")
        
        result = execute_lxc(full_command, timeout=timeout)
        
        logger.info(f"Execute API: Command completed with returncode {result['returncode']}")
        
        return jsonify(result), 200 if result["success"] else 500
        
    except Exception as e:
        logger.error(f"Execute API error: {str(e)}", exc_info=True)
        return jsonify({
            "success": False,
            "returncode": 1,
            "stdout": "",
            "stderr": str(e),
            "command": data.get('command', 'unknown') if 'data' in locals() else 'unknown'
        }), 500

@app.route('/api/debug/test-execute', methods=['POST'])
@require_api_key
def api_debug_test_execute():
    """Debug endpoint to test command execution"""
    try:
        data = request.get_json() or {}
        test_command = data.get('command', 'lxc version')
        
        logger.info(f"Debug test execute: {test_command}")
        
        # Test basic command execution
        result = execute_lxc(test_command, timeout=10)
        
        return jsonify({
            "test_command": test_command,
            "result": result,
            "lxc_available": shutil.which("lxc") is not None,
            "lxc_path": shutil.which("lxc"),
            "timestamp": datetime.now().isoformat()
        }), 200
        
    except Exception as e:
        logger.error(f"Debug test execute error: {str(e)}", exc_info=True)
        return jsonify({
            "error": str(e),
            "lxc_available": shutil.which("lxc") is not None,
            "lxc_path": shutil.which("lxc")
        }), 500

@app.route('/api/host/stats', methods=['GET'])
@require_api_key
def api_get_host_stats():
    """Get host system statistics"""
    try:
        stats = get_host_stats()
        return jsonify(stats), 200
    except Exception as e:
        logger.error(f"Host stats API error: {str(e)}")
        return jsonify({"error": str(e)}), 500

@app.route('/api/container/stats', methods=['POST'])
@require_api_key
def api_get_container_stats():
    """Get container statistics"""
    try:
        data = request.get_json()
        if not data or 'container' not in data:
            return jsonify({"error": "Missing 'container' in request body"}), 400
        
        container_name = data['container']
        stats = get_container_stats(container_name)
        
        return jsonify(stats), 200
        
    except Exception as e:
        logger.error(f"Container stats API error: {str(e)}")
        return jsonify({"error": str(e)}), 500

@app.route('/api/container/list', methods=['GET'])
@require_api_key
def api_list_containers():
    """List all containers with their statuses"""
    try:
        containers = list_containers()
        statuses = {}
        
        for c in containers:
            statuses[c] = get_container_status(c)
        
        return jsonify({
            "containers": containers,
            "statuses": statuses,
            "count": len(containers)
        }), 200
        
    except Exception as e:
        logger.error(f"List containers API error: {str(e)}")
        return jsonify({"error": str(e)}), 500

@app.route('/api/container/start', methods=['POST'])
@require_api_key
def api_start_container():
    """Start a container"""
    try:
        data = request.get_json()
        if not data or 'container' not in data:
            return jsonify({"error": "Missing 'container' in request body"}), 400
        
        container = data['container']
        timeout = data.get('timeout', 60)
        
        result = container_action(container, 'start', timeout=timeout)
        
        return jsonify(result), 200 if result["success"] else 500
        
    except Exception as e:
        logger.error(f"Start container API error: {str(e)}")
        return jsonify({"success": False, "error": str(e)}), 500

@app.route('/api/container/stop', methods=['POST'])
@require_api_key
def api_stop_container():
    """Stop a container"""
    try:
        data = request.get_json()
        if not data or 'container' not in data:
            return jsonify({"error": "Missing 'container' in request body"}), 400
        
        container = data['container']
        timeout = data.get('timeout', 60)
        force = data.get('force', False)
        
        # Use force stop if requested
        if force:
            result = container_action(container, 'stop', timeout=timeout)
            if not result['success']:
                # Try force kill
                logger.warning(f"Normal stop failed, attempting force stop for {container}")
                kill_result = execute_lxc(f"lxc stop {container} --force", timeout=30)
                result['force_used'] = True
                result['success'] = kill_result['success']
                result['stderr'] = kill_result.get('stderr', '')
        else:
            result = container_action(container, 'stop', timeout=timeout)
        
        return jsonify(result), 200 if result["success"] else 500
        
    except Exception as e:
        logger.error(f"Stop container API error: {str(e)}")
        return jsonify({"success": False, "error": str(e)}), 500

@app.route('/api/container/restart', methods=['POST'])
@require_api_key
def api_restart_container():
    """Restart a container"""
    try:
        data = request.get_json()
        if not data or 'container' not in data:
            return jsonify({"error": "Missing 'container' in request body"}), 400
        
        container = data['container']
        timeout = data.get('timeout', 60)
        
        result = container_action(container, 'restart', timeout=timeout)
        
        return jsonify(result), 200 if result["success"] else 500
        
    except Exception as e:
        logger.error(f"Restart container API error: {str(e)}")
        return jsonify({"success": False, "error": str(e)}), 500

@app.route('/api/info', methods=['GET'])
@require_api_key
def api_info():
    """Get comprehensive node agent information"""
    try:
        # Get system information
        host_stats = get_host_stats()
        containers = list_containers()
        
        # Get LXC information
        lxc_available = shutil.which("lxc") is not None
        lxc_version = "Unknown"
        if lxc_available:
            try:
                result = subprocess.run(
                    ["lxc", "version"],
                    capture_output=True,
                    text=True,
                    timeout=5
                )
                if result.returncode == 0:
                    lxc_version = result.stdout.strip()
            except:
                pass
        
        # Get container statuses
        container_statuses = {}
        running_count = 0
        stopped_count = 0
        
        for container in containers[:20]:  # Limit to first 20 for performance
            status = get_container_status(container)
            container_statuses[container] = status
            if status == 'running':
                running_count += 1
            elif status == 'stopped':
                stopped_count += 1
        
        return jsonify({
            "version": VERSION,
            "developer": DEVELOPER,
            "python_version": sys.version.split()[0],
            "host": HOST,
            "port": PORT,
            "hostname": socket.gethostname(),
            "uptime": get_host_uptime(),
            "lxc": {
                "available": lxc_available,
                "version": lxc_version
            },
            "resources": {
                "cpu": host_stats['cpu'],
                "ram": host_stats['ram'],
                "disk": host_stats['disk']
            },
            "containers": {
                "total": len(containers),
                "running": running_count,
                "stopped": stopped_count,
                "statuses": container_statuses
            },
            "timestamp": datetime.now().isoformat()
        }), 200
        
    except Exception as e:
        logger.error(f"Info API error: {str(e)}")
        return jsonify({
            "error": str(e),
            "version": VERSION,
            "timestamp": datetime.now().isoformat()
        }), 500

@app.route('/api/container/delete', methods=['POST'])
@require_api_key
def api_delete_container():
    """Delete a container"""
    try:
        data = request.get_json()
        if not data or 'container' not in data:
            return jsonify({"error": "Missing 'container' in request body"}), 400
        
        container = data['container']
        force = data.get('force', False)
        
        # Check if container exists
        status = get_container_status(container)
        if status in ['unknown', 'error']:
            return jsonify({
                "success": False,
                "error": f"Container not found: {container}"
            }), 404
        
        # Stop container if running
        if status == 'running':
            logger.info(f"Stopping container before deletion: {container}")
            stop_result = container_action(container, 'stop', timeout=30)
            if not stop_result['success'] and not force:
                return jsonify({
                    "success": False,
                    "error": "Failed to stop container. Use force=true to delete anyway.",
                    "stop_result": stop_result
                }), 500
        
        # Delete container
        cmd = f"lxc delete {container}"
        if force:
            cmd += " --force"
        
        result = execute_lxc(cmd, timeout=60)
        
        return jsonify({
            "success": result["success"],
            "container": container,
            "message": f"Container {container} deleted successfully" if result["success"] else "Failed to delete container",
            "details": result
        }), 200 if result["success"] else 500
        
    except Exception as e:
        logger.error(f"Delete container API error: {str(e)}")
        return jsonify({"success": False, "error": str(e)}), 500

@app.route('/api/container/exec', methods=['POST'])
@require_api_key
def api_container_exec():
    """Execute command inside a container"""
    try:
        data = request.get_json()
        if not data or 'container' not in data or 'command' not in data:
            return jsonify({"error": "Missing 'container' or 'command' in request body"}), 400
        
        container = data['container']
        command = data['command']
        timeout = data.get('timeout', 60)
        
        # Check if container is running
        status = get_container_status(container)
        if status != 'running':
            return jsonify({
                "success": False,
                "error": f"Container is not running (status: {status})"
            }), 400
        
        # Build exec command
        full_cmd = f"lxc exec {container} -- {command}"
        result = execute_lxc(full_cmd, timeout=timeout)
        
        return jsonify(result), 200 if result["success"] else 500
        
    except Exception as e:
        logger.error(f"Container exec API error: {str(e)}")
        return jsonify({"success": False, "error": str(e)}), 500

@app.route('/api/system/check', methods=['GET'])
@require_api_key
def api_system_check():
    """Comprehensive system health check"""
    try:
        # Check LXC/LXD availability
        lxc_available = shutil.which("lxc") is not None
        lxc_ls_available = shutil.which("lxc-ls") is not None
        
        # Get LXC version
        lxc_version = "Unknown"
        if lxc_available:
            try:
                result = subprocess.run(
                    ["lxc", "version"],
                    capture_output=True,
                    text=True,
                    timeout=5
                )
                if result.returncode == 0:
                    lxc_version = result.stdout.strip()
            except:
                pass
        
        # Get system info
        host_stats = get_host_stats()
        containers = list_containers()
        
        # Check critical thresholds
        warnings = []
        errors = []
        
        if not lxc_available:
            errors.append("LXC command not found - node cannot manage containers")
        
        if host_stats['cpu'] > 95:
            errors.append(f"CRITICAL: CPU usage at {host_stats['cpu']}%")
        elif host_stats['cpu'] > 85:
            warnings.append(f"WARNING: High CPU usage at {host_stats['cpu']}%")
        
        if host_stats['ram']['percent'] > 95:
            errors.append(f"CRITICAL: RAM usage at {host_stats['ram']['percent']}%")
        elif host_stats['ram']['percent'] > 85:
            warnings.append(f"WARNING: High RAM usage at {host_stats['ram']['percent']}%")
        
        disk_percent = host_stats['disk']['percent'].rstrip('%')
        try:
            disk_val = float(disk_percent)
            if disk_val > 95:
                errors.append(f"CRITICAL: Disk usage at {disk_percent}%")
            elif disk_val > 85:
                warnings.append(f"WARNING: High disk usage at {disk_percent}%")
        except:
            pass
        
        # Determine overall status
        if errors:
            status = "critical"
        elif warnings:
            status = "warning"
        else:
            status = "healthy"
        
        # Test container operations
        can_list_containers = len(containers) >= 0  # If we got here, listing worked
        
        return jsonify({
            "status": status,
            "lxc_available": lxc_available,
            "lxc_ls_available": lxc_ls_available,
            "lxc_version": lxc_version,
            "can_list_containers": can_list_containers,
            "container_count": len(containers),
            "host_stats": host_stats,
            "warnings": warnings,
            "errors": errors,
            "checks": {
                "lxc_installed": lxc_available,
                "can_execute_commands": True,  # If we got here, we can execute
                "sufficient_resources": len(errors) == 0
            },
            "timestamp": datetime.now().isoformat()
        }), 200
        
    except Exception as e:
        logger.error(f"System check API error: {str(e)}")
        return jsonify({
            "status": "error",
            "error": str(e),
            "checks": {
                "lxc_installed": False,
                "can_execute_commands": False,
                "sufficient_resources": False
            }
        }), 500

@app.route('/api/validate', methods=['POST'])
@require_api_key
def api_validate_node():
    """Validate node configuration and capabilities - used by HVM Panel during node setup"""
    try:
        # Get validation parameters from request
        data = request.get_json() or {}
        test_container = data.get('test_container')  # Optional: test specific container
        
        validation_results = {
            "success": True,
            "node_ready": True,
            "checks": {},
            "errors": [],
            "warnings": [],
            "info": {}
        }
        
        # Check 1: LXC/LXD availability
        lxc_available = shutil.which("lxc") is not None
        validation_results["checks"]["lxc_available"] = lxc_available
        if not lxc_available:
            validation_results["success"] = False
            validation_results["node_ready"] = False
            validation_results["errors"].append("LXC command not found")
        else:
            validation_results["info"]["lxc_path"] = shutil.which("lxc")
        
        # Check 2: LXC version
        if lxc_available:
            try:
                result = subprocess.run(
                    ["lxc", "version"],
                    capture_output=True,
                    text=True,
                    timeout=5
                )
                if result.returncode == 0:
                    lxc_version = result.stdout.strip()
                    validation_results["info"]["lxc_version"] = lxc_version
                    validation_results["checks"]["lxc_version_detected"] = True
                else:
                    validation_results["checks"]["lxc_version_detected"] = False
                    validation_results["warnings"].append("Could not detect LXC version")
            except Exception as e:
                validation_results["checks"]["lxc_version_detected"] = False
                validation_results["warnings"].append(f"LXC version check failed: {str(e)}")
        
        # Check 3: Can list containers
        try:
            containers = list_containers()
            validation_results["checks"]["can_list_containers"] = True
            validation_results["info"]["container_count"] = len(containers)
            validation_results["info"]["containers"] = containers[:10]  # First 10
        except Exception as e:
            validation_results["checks"]["can_list_containers"] = False
            validation_results["errors"].append(f"Cannot list containers: {str(e)}")
            validation_results["node_ready"] = False
        
        # Check 4: Resource availability
        try:
            host_stats = get_host_stats()
            validation_results["checks"]["can_get_stats"] = True
            validation_results["info"]["resources"] = {
                "cpu_usage": host_stats['cpu'],
                "ram": host_stats['ram'],
                "disk": host_stats['disk']
            }
            
            # Check if resources are critically low
            if host_stats['cpu'] > 95:
                validation_results["warnings"].append(f"CPU usage critically high: {host_stats['cpu']}%")
            
            if host_stats['ram']['percent'] > 95:
                validation_results["warnings"].append(f"RAM usage critically high: {host_stats['ram']['percent']}%")
            
            try:
                disk_percent = float(host_stats['disk']['percent'].rstrip('%'))
                if disk_percent > 95:
                    validation_results["warnings"].append(f"Disk usage critically high: {disk_percent}%")
            except:
                pass
                
        except Exception as e:
            validation_results["checks"]["can_get_stats"] = False
            validation_results["warnings"].append(f"Cannot get resource stats: {str(e)}")
        
        # Check 5: Test specific container if provided
        if test_container:
            try:
                status = get_container_status(test_container)
                validation_results["checks"]["test_container_accessible"] = status not in ['unknown', 'error']
                validation_results["info"]["test_container_status"] = status
                
                if status in ['unknown', 'error']:
                    validation_results["warnings"].append(f"Test container '{test_container}' not found or inaccessible")
            except Exception as e:
                validation_results["checks"]["test_container_accessible"] = False
                validation_results["warnings"].append(f"Cannot check test container: {str(e)}")
        
        # Check 6: Can execute commands
        try:
            result = subprocess.run(
                ["echo", "test"],
                capture_output=True,
                text=True,
                timeout=5
            )
            validation_results["checks"]["can_execute_commands"] = result.returncode == 0
        except Exception as e:
            validation_results["checks"]["can_execute_commands"] = False
            validation_results["errors"].append(f"Cannot execute commands: {str(e)}")
            validation_results["node_ready"] = False
        
        # Check 7: Network connectivity
        validation_results["checks"]["network_accessible"] = True  # If we got here, network works
        validation_results["info"]["client_ip"] = request.remote_addr
        validation_results["info"]["hostname"] = socket.gethostname()
        
        # Final determination
        if validation_results["errors"]:
            validation_results["success"] = False
            validation_results["node_ready"] = False
        
        # Add timestamp
        validation_results["timestamp"] = datetime.now().isoformat()
        
        logger.info(f"Node validation completed: ready={validation_results['node_ready']}, "
                   f"errors={len(validation_results['errors'])}, warnings={len(validation_results['warnings'])}")
        
        return jsonify(validation_results), 200
        
    except Exception as e:
        logger.error(f"Node validation error: {str(e)}")
        return jsonify({
            "success": False,
            "node_ready": False,
            "error": str(e),
            "timestamp": datetime.now().isoformat()
        }), 500

@app.route('/api/container/snapshot', methods=['POST'])
@require_api_key
def api_container_snapshot():
    """Create, restore, or delete container snapshots"""
    try:
        data = request.get_json()
        if not data or 'container' not in data or 'action' not in data:
            return jsonify({"error": "Missing 'container' or 'action' in request body"}), 400
        
        container = data['container']
        action = data['action']  # create, restore, delete, list
        snapshot_name = data.get('snapshot_name', f"snap-{datetime.now().strftime('%Y%m%d-%H%M%S')}")
        
        # Validate action
        valid_actions = ['create', 'restore', 'delete', 'list']
        if action not in valid_actions:
            return jsonify({
                "error": f"Invalid action. Must be one of: {', '.join(valid_actions)}"
            }), 400
        
        # Check if container exists
        status = get_container_status(container)
        if status in ['unknown', 'error']:
            return jsonify({
                "success": False,
                "error": f"Container not found: {container}"
            }), 404
        
        result = None
        
        if action == 'create':
            cmd = f"lxc snapshot {container} {snapshot_name}"
            result = execute_lxc(cmd, timeout=120)
            
        elif action == 'restore':
            if not snapshot_name or snapshot_name.startswith('snap-'):
                return jsonify({
                    "error": "snapshot_name is required for restore action"
                }), 400
            cmd = f"lxc restore {container} {snapshot_name}"
            result = execute_lxc(cmd, timeout=120)
            
        elif action == 'delete':
            if not snapshot_name or snapshot_name.startswith('snap-'):
                return jsonify({
                    "error": "snapshot_name is required for delete action"
                }), 400
            cmd = f"lxc delete {container}/{snapshot_name}"
            result = execute_lxc(cmd, timeout=60)
            
        elif action == 'list':
            cmd = f"lxc info {container}"
            result = execute_lxc(cmd, timeout=30)
            
            # Parse snapshots from output
            snapshots = []
            if result['success']:
                in_snapshots = False
                for line in result['stdout'].split('\n'):
                    if 'Snapshots:' in line:
                        in_snapshots = True
                        continue
                    if in_snapshots and line.strip():
                        if line.startswith(' '):
                            snapshot_info = line.strip()
                            if snapshot_info:
                                snapshots.append(snapshot_info)
                        else:
                            break
            
            return jsonify({
                "success": result['success'],
                "container": container,
                "snapshots": snapshots,
                "count": len(snapshots)
            }), 200
        
        return jsonify({
            "success": result['success'] if result else False,
            "container": container,
            "action": action,
            "snapshot_name": snapshot_name,
            "details": result
        }), 200 if (result and result['success']) else 500
        
    except Exception as e:
        logger.error(f"Container snapshot API error: {str(e)}")
        return jsonify({"success": False, "error": str(e)}), 500

# Error handlers
@app.errorhandler(400)
def bad_request(error):
    return jsonify({"error": "Bad Request", "message": str(error)}), 400

@app.errorhandler(401)
def unauthorized(error):
    return jsonify({"error": "Unauthorized", "message": str(error)}), 401

@app.errorhandler(404)
def not_found(error):
    return jsonify({"error": "Not Found", "message": str(error)}), 404

@app.errorhandler(500)
def internal_error(error):
    return jsonify({"error": "Internal Server Error", "message": str(error)}), 500

# Health monitor thread
def health_monitor(interval: int = 60):
    """Monitor and log host health periodically with enhanced checks"""
    logger.info(f"Health monitor started (interval: {interval}s)")
    
    consecutive_errors = 0
    max_consecutive_errors = 5
    
    while not shutdown_event.is_set():
        try:
            stats = get_host_stats()
            ram = stats['ram']
            disk = stats['disk']
            cpu = stats['cpu']
            
            # Build status message
            status_parts = [
                f"CPU: {cpu:.1f}%",
                f"RAM: {ram['percent']:.1f}% ({ram['used']}MB/{ram['total']}MB)",
                f"Disk: {disk['percent']}",
                f"Uptime: {stats['uptime']}"
            ]
            
            logger.info(f"Host Health - {' | '.join(status_parts)}")
            
            # Check for critical conditions
            warnings = []
            if cpu > 95:
                warnings.append(f"CRITICAL: CPU usage at {cpu:.1f}%")
            elif cpu > 85:
                warnings.append(f"WARNING: High CPU usage at {cpu:.1f}%")
            
            if ram['percent'] > 95:
                warnings.append(f"CRITICAL: RAM usage at {ram['percent']:.1f}%")
            elif ram['percent'] > 85:
                warnings.append(f"WARNING: High RAM usage at {ram['percent']:.1f}%")
            
            # Parse disk percentage
            try:
                disk_percent = float(disk['percent'].rstrip('%'))
                if disk_percent > 95:
                    warnings.append(f"CRITICAL: Disk usage at {disk_percent:.1f}%")
                elif disk_percent > 85:
                    warnings.append(f"WARNING: High disk usage at {disk_percent:.1f}%")
            except (ValueError, AttributeError):
                pass
            
            # Log warnings
            for warning in warnings:
                logger.warning(warning)
            
            # Reset error counter on success
            consecutive_errors = 0
            
            # Wait for next check
            shutdown_event.wait(interval)
            
        except Exception as e:
            consecutive_errors += 1
            logger.error(f"Health monitor error ({consecutive_errors}/{max_consecutive_errors}): {e}")
            
            if consecutive_errors >= max_consecutive_errors:
                logger.critical(f"Health monitor failed {max_consecutive_errors} times consecutively. Continuing anyway...")
                consecutive_errors = 0  # Reset to avoid spam
            
            shutdown_event.wait(interval)
    
    logger.info("Health monitor stopped")

if __name__ == '__main__':
    # Load .env first
    env_config = load_env()

    # Argument parser (overrides .env)
    parser = argparse.ArgumentParser(
        description=f'HVM Panel Node Agent v{VERSION}',
        formatter_class=argparse.RawDescriptionHelpFormatter
    )
    parser.add_argument('--api-key', dest='api_key', help='API Key for authentication (overrides .env)')
    parser.add_argument('--port', type=int, help='Port to listen on (default: 5000, overrides .env)')
    parser.add_argument('--host', help='Host to bind (default: 0.0.0.0, overrides .env)')
    parser.add_argument('--log-level', dest='log_level', help='Log level: DEBUG, INFO, WARNING, ERROR (overrides .env)')
    parser.add_argument('--log-file', dest='log_file', help='Log file path (default: node-agent.log)')
    parser.add_argument('--monitor-interval', dest='monitor_interval', type=int, help='Health monitor interval in seconds (default: 60)')
    args = parser.parse_args()

    # Setup logging
    log_level = args.log_level or env_config.get('LOG_LEVEL', 'INFO')
    log_file = args.log_file or env_config.get('LOG_FILE', 'node-agent.log')
    setup_logging(log_level, log_file)

    # Get API key
    API_KEY = args.api_key or env_config.get('API_KEY')
    if not API_KEY:
        logger.error("API_KEY is required. Set it in .env or use --api-key")
        parser.error("API_KEY is required. Set it in .env or use --api-key")

    # Get host and port
    PORT = args.port or int(env_config.get('PORT', 5000))
    HOST = args.host or env_config.get('HOST', '0.0.0.0')
    
    # Get monitor interval
    HEALTH_MONITOR_INTERVAL = args.monitor_interval or int(env_config.get('MONITOR_INTERVAL', 60))

    # Startup information
    logger.info("=" * 79)
    logger.info(f"HVM Panel Node Agent v{VERSION}")
    logger.info(f"Developer: {DEVELOPER}")
    logger.info("=" * 79)
    logger.info(f"Configuration:")
    logger.info(f"  - Bind Address: {HOST}:{PORT}")
    logger.info(f"  - API Key: {API_KEY[:8]}{'*' * max(0, len(API_KEY) - 8)}")
    logger.info(f"  - Log Level: {log_level}")
    logger.info(f"  - Log File: {log_file}")
    logger.info(f"  - Health Monitor: Every {HEALTH_MONITOR_INTERVAL}s")
    logger.info("=" * 79)
    
    # System checks
    logger.info("Performing system checks...")
    lxc_cmd = shutil.which("lxc")
    lxc_ls_cmd = shutil.which("lxc-ls")
    
    if lxc_cmd:
        logger.info(f"  ✓ LXC command found: {lxc_cmd}")
    else:
        logger.warning("  ✗ LXC command not found")
    
    if lxc_ls_cmd:
        logger.info(f"  ✓ LXC-LS command found: {lxc_ls_cmd}")
    else:
        logger.warning("  ✗ LXC-LS command not found")
    
    # Check for required tools
    tools = ['free', 'df', 'mpstat', 'top']
    for tool in tools:
        tool_path = shutil.which(tool)
        if tool_path:
            logger.info(f"  ✓ {tool} found: {tool_path}")
        else:
            logger.warning(f"  ✗ {tool} not found (optional)")
    
    logger.info("=" * 79)

    # Start health monitor thread
    logger.info("Starting health monitor thread...")
    monitor_thread = threading.Thread(
        target=health_monitor,
        args=(HEALTH_MONITOR_INTERVAL,),
        daemon=True,
        name="HealthMonitor"
    )
    monitor_thread.start()
    logger.info("Health monitor thread started successfully")

    # Run Flask app
    try:
        logger.info("=" * 79)
        logger.info(f"Node agent is ready to accept connections on http://{HOST}:{PORT}")
        logger.info("Press Ctrl+C to stop the server")
        logger.info("=" * 79)
        
        app.run(host=HOST, port=PORT, debug=False, threaded=True)
        
    except KeyboardInterrupt:
        logger.info("\nReceived keyboard interrupt, shutting down gracefully...")
        shutdown_event.set()
    except Exception as e:
        logger.error(f"Fatal error: {e}", exc_info=True)
        shutdown_event.set()
        sys.exit(1)
    finally:
        logger.info("Node agent stopped")

