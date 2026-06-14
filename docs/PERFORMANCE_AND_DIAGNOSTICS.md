# Performance & Diagnostics Guide

This guide helps you monitor, diagnose, and optimize kit performance in your projects.

## Quick Diagnostics

### Run Health Check

```bash
# Full diagnostic
kit doctor

# Output shows:
# ✓ kit version and updates
# ✓ Node.js version and compatibility
# ✓ Tool versions (mise, git, etc.)
# ✓ Project configuration validity
# ✓ Performance metrics
# ✓ Common issues detected
```

### Check System Status

```bash
# Quick status
kit check

# Shows:
# ✓ Tools installed and correct versions
# ✓ Services configured
# ✓ Secrets available
# ✓ Any warnings/errors
```

## Performance Monitoring

### Setup Performance

Track how long various operations take:

```bash
# Measure setup time
time kit setup

# Breaks down to:
# - Tool installation: X seconds
# - Service provisioning: Y seconds
# - Project setup: Z seconds
```

### Command Performance

Each kit command reports performance:

```bash
# Example output
$ kit check
✓ Completed in 2.34s

# Breakdown:
# ├─ Tools check: 0.45s
# ├─ Services check: 1.20s
# ├─ Secrets check: 0.35s
# └─ Locks check: 0.34s
```

### Plugin Performance

Check individual plugin performance:

```bash
kit plugin list --timing

# Output:
# stripe/payments: 0.12s (check)
# supabase/database: 0.34s (check)
# vercel/hosting: 0.08s (check)
# Total: 0.54s
```

## Diagnostic Tools

### kit doctor

Comprehensive system diagnosis:

```bash
kit doctor

# Checks:
# ─────────────────────────────────────
# kit Installation
#   ✓ Version: 1.0.0
#   ✓ Location: /usr/local/bin/kit
#   ℹ Update available: 1.0.1
#
# Node.js Environment
#   ✓ Version: 18.16.0
#   ✓ npm: 9.6.4
#   ✓ Git: 2.40.0
#
# Project Configuration
#   ✓ .kit.toml found
#   ✓ Valid configuration
#   ⚠ Node.js version mismatch: expected >=18
#
# Tools & Services
#   ✓ Stripe configured and working
#   ⚠ Database not configured
#   ✗ Redis missing (required)
#
# Performance Metrics
#   ℹ Average setup time: 12.3s
#   ℹ Last check duration: 2.1s
#
# Recommendations:
#   1. Update kit to 1.0.1
#   2. Install Redis to 7.0
#   3. Configure database service
```

### Performance Baseline

Establish and track performance:

```bash
# Capture baseline
kit doctor --save-baseline

# Later, compare
kit doctor --compare-baseline

# Shows:
# Operation         Before    Now      Change
# ─────────────────────────────────────────
# Tool install      3.2s      3.5s     +0.3s
# Service config    1.8s      2.1s     +0.3s
# Project setup     4.2s      4.5s     +0.3s
# Total setup       9.2s      10.1s    +0.9s
```

## Common Performance Issues & Solutions

### Issue: Slow `kit setup`

**Symptoms:** Setup takes 20+ seconds

**Diagnosis:**
```bash
kit setup --verbose

# Look for slow steps
# [SLOW] Installing Node.js dependencies: 15.2s
# [SLOW] Service provisioning: 8.5s
```

**Solutions:**

1. **Slow npm install**
   ```bash
   # Use npm ci instead of install (faster for CI)
   npm ci
   
   # Check for large dependencies
   npm ls --depth=0
   
   # Optimize dependencies
   npm prune
   ```

2. **Slow tool downloads**
   ```bash
   # Tools are cached, subsequent runs faster
   kit setup  # First: 25s
   kit setup  # Second: 3s (tools already installed)
   ```

3. **Slow service provisioning**
   ```bash
   # Some services have network calls
   # Check service status
   kit add stripe/payments --check
   
   # If slow, service may be down
   # Retry or use cached configuration
   ```

### Issue: High CPU Usage

**Symptoms:** kit commands use 100% CPU

**Diagnosis:**
```bash
# Check what's running
kit check --verbose

# Use system monitoring
top -p $(pgrep -f kit)
```

**Solutions:**

1. **Background operations**
   - Some checks run in parallel
   - Safe to interrupt with Ctrl+C if needed

2. **Disable expensive checks**
   ```bash
   kit check --skip=network  # Skip network checks
   ```

3. **Run during off-hours**
   - Schedule `kit setup` in CI during off-peak

### Issue: High Memory Usage

**Symptoms:** `kit setup` uses >500MB RAM

**Diagnosis:**
```bash
# Monitor memory
watch -n 1 'kit check 2>&1 | tail -3'

# Profile with Node.js
node --trace-warnings $(which kit) check
```

**Solutions:**

1. **Reduce parallel checks**
   ```bash
   kit check --max-parallel=2
   ```

2. **Check for memory leaks**
   ```bash
   kit doctor --memory-check
   ```

3. **Use streaming for large operations**
   ```bash
   # Some operations can stream instead of buffering
   kit clone --stream-output
   ```

### Issue: Intermittent Timeouts

**Symptoms:** Setup sometimes fails with timeout errors

**Diagnosis:**
```bash
kit setup --verbose --debug

# Check network connectivity
kit check --verbose
```

**Solutions:**

1. **Increase timeouts**
   ```toml
   # .kit.toml
   [config]
   request_timeout = 30  # Default: 10s
   retry_attempts = 3    # Default: 1
   ```

2. **Check network**
   ```bash
   # Test connectivity to services
   curl -I https://api.stripe.com
   nslookup api.github.com
   ```

3. **Use caching**
   ```bash
   # kit caches responses
   # Subsequent calls faster
   kit check  # First: slow (network calls)
   kit check  # Second: fast (cached)
   ```

## Optimization Tips

### 1. Leverage Caching

kit caches tool downloads and configurations:

```bash
# First setup: ~20-30s (downloads tools)
kit setup

# Second setup: ~3-5s (uses cache)
kit setup

# To bypass cache:
kit setup --no-cache
```

### 2. Use Local Development

For development, local databases are faster:

```toml
# .kit.toml
[environments.development]
tools.postgres = "14.0"  # Local Postgres

[environments.production]
# Uses cloud database
```

### 3. Parallel Execution

kit runs checks in parallel where possible:

```bash
# Tools, services, and secrets checked in parallel
kit check --max-parallel=4  # Default: 8
```

### 4. Reduce Unnecessary Checks

Skip checks you don't need:

```bash
# Faster
kit check --skip=security

# Typical breakdown:
# Tools: 0.3s
# Services: 0.5s
# Secrets: 0.2s
# Security: 1.5s (slowest)
# Total: 2.5s (without security: 1.0s)
```

### 5. Pre-warm Caches

Before running CI:

```bash
# Cache tool downloads
kit install --all

# Cache service status
kit add --all

# Now CI runs faster
# (tools already installed, services pre-checked)
```

## Metrics & Monitoring

### Collect Metrics

Enable metrics collection:

```toml
# .kit.toml
[config]
metrics_enabled = true
metrics_file = ".kit/metrics.json"
```

### View Metrics

```bash
kit metrics

# Shows:
# Operation        Count  Total Time  Avg Time
# ────────────────────────────────────────────
# kit setup       12     138.4s    11.5s
# kit check      156     389.2s     2.5s
# npm install        12     143.2s    11.9s
```

### Export for Analysis

```bash
kit metrics --export=csv > metrics.csv

# Import into spreadsheet for analysis
# Track trends over time
```

## Benchmarking

### Establish Baseline

```bash
# Baseline for your project
kit doctor --save baseline

# Commit to git
git add .kit/baseline.json
```

### Track Changes

After making changes:

```bash
kit doctor --compare baseline

# See performance impact of:
# - Updating dependencies
# - Adding new services
# - Upgrading kit
```

### Compare Environments

```bash
# Benchmark in CI
kit doctor --save ci-baseline

# Benchmark locally
kit doctor --compare ci-baseline

# Identify differences:
# - CI: slower networks, shared resources
# - Local: faster hardware, dedicated resources
```

## Troubleshooting Performance

### Performance Regression

If performance suddenly degrades:

```bash
# Check what changed
git log --oneline -5

# Revert recent changes
git revert <commit>

# Re-test
kit setup
```

### Memory Leaks

Identify memory leaks:

```bash
# Profile memory usage
kit check --profile=memory

# Look for unbounded growth
# or check for leaked file handles
lsof -p $(pgrep -f kit)
```

### CPU Profiling

```bash
# Generate CPU profile
kit check --profile=cpu

# Analyze with chrome devtools
node --prof-process isolate-*.log > profile.txt
```

## Best Practices

✅ **DO**
- Run `kit doctor` regularly
- Monitor setup time trends
- Optimize CI/CD pipelines
- Cache tool downloads in CI
- Use local development mode
- Enable metrics collection

❌ **DON'T**
- Disable security checks in production
- Ignore performance warnings
- Allow setup time to grow unbounded
- Skip diagnostics when debugging issues
- Run expensive operations in tight loops

## Resources

- [Performance Baseline](./PERFORMANCE_AND_DIAGNOSTICS.md#establish-baseline)
- [Common Issues](./PERFORMANCE_AND_DIAGNOSTICS.md#common-performance-issues--solutions)
- [Optimization Tips](./PERFORMANCE_AND_DIAGNOSTICS.md#optimization-tips)
- [GitHub Issues](https://github.com/sandstream/kit/issues)

---

**Last Updated:** 2026-04-15  
**Status:** Stable  
**Performance Target:** <5s for `kit check` on typical projects
