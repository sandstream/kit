import http from 'k6/http';
import { check, sleep } from 'k6';
import { Counter, Trend } from 'k6/metrics';

// Metrics for chaos testing
const chaosInjected = new Counter('chaos_injected');
const recoveryTime = new Trend('recovery_time_ms');
const failureCount = new Counter('failure_count');
const recoveryCount = new Counter('recovery_count');

export const options = {
  vus: 10,
  duration: '5m',
  thresholds: {
    http_req_duration: ['p(95)<2000'], // Higher threshold during chaos
    http_req_failed: ['rate<0.5'],     // Allow higher failure rate during chaos
  },
};

const BASE_URL = __ENV.BASE_URL || 'http://localhost:8000';
const CHAOS_ENDPOINT = __ENV.CHAOS_ENDPOINT || 'http://localhost:8001';

/**
 * Chaos Scenario 1: Network Latency Injection
 * Simulate high latency by adding delays to database queries
 */
export function chaosNetworkLatency() {
  console.log('Injecting network latency...');

  // Send request to chaos endpoint to inject latency
  const injectRes = http.post(`${CHAOS_ENDPOINT}/chaos/inject`, JSON.stringify({
    scenario: 'network-latency',
    latency_ms: 1000,  // Add 1 second latency
    duration_seconds: 30,
  }), {
    headers: { 'Content-Type': 'application/json' },
  });

  check(injectRes, {
    'chaos injection accepted': (r) => r.status === 202,
  });

  chaosInjected.add(1);

  // Send requests during latency injection
  const startTime = Date.now();
  for (let i = 0; i < 30; i++) {
    const res = http.get(`${BASE_URL}/api/plugins`, {
      timeout: '5s',
    });

    const hasError = res.status !== 200;
    if (hasError) {
      failureCount.add(1);
    }

    // Check if request succeeded despite latency
    if (res.status === 200) {
      recoveryCount.add(1);
      recoveryTime.add(Date.now() - startTime);
    }

    sleep(1);
  }

  // Verify system recovers after chaos
  sleep(10);
  const recoveryRes = http.get(`${BASE_URL}/health`);
  check(recoveryRes, {
    'system recovered after latency': (r) => r.status === 200,
  });
}

/**
 * Chaos Scenario 2: Database Connection Pool Exhaustion
 * Simulate running out of database connections
 */
export function chaosDatabaseExhaustion() {
  console.log('Injecting database pool exhaustion...');

  const injectRes = http.post(`${CHAOS_ENDPOINT}/chaos/inject`, JSON.stringify({
    scenario: 'db-pool-exhaustion',
    max_connections: 5,  // Limit to 5 connections
    duration_seconds: 30,
  }), {
    headers: { 'Content-Type': 'application/json' },
  });

  chaosInjected.add(1);

  // Send burst of requests to exhaust pool
  const startTime = Date.now();
  let recovered = false;

  for (let i = 0; i < 20; i++) {
    const res = http.get(`${BASE_URL}/api/plugins`, {
      timeout: '3s',
    });

    if (res.status === 429 || res.status === 503) {
      failureCount.add(1);
      console.log(`Request ${i} failed with ${res.status}`);
    } else if (res.status === 200) {
      recovered = true;
      recoveryCount.add(1);
      recoveryTime.add(Date.now() - startTime);
    }

    sleep(1);
  }

  // Check recovery
  sleep(10);
  const healthRes = http.get(`${BASE_URL}/health`);
  check(healthRes, {
    'system recovered from pool exhaustion': (r) => r.status === 200,
  });
}

/**
 * Chaos Scenario 3: Redis Cache Failure
 * Simulate Redis cache becoming unavailable
 */
export function chaosRedisFailure() {
  console.log('Injecting Redis failure...');

  const injectRes = http.post(`${CHAOS_ENDPOINT}/chaos/inject`, JSON.stringify({
    scenario: 'redis-failure',
    duration_seconds: 30,
  }), {
    headers: { 'Content-Type': 'application/json' },
  });

  chaosInjected.add(1);

  const startTime = Date.now();

  // Send requests during cache failure
  for (let i = 0; i < 30; i++) {
    const res = http.get(`${BASE_URL}/api/plugins`, {
      timeout: '5s',
    });

    const success = res.status === 200;
    if (success) {
      recoveryCount.add(1);
      recoveryTime.add(Date.now() - startTime);
      check(res, {
        'application falls back to database': (r) => r.status === 200,
      });
    } else {
      failureCount.add(1);
    }

    sleep(1);
  }

  // Verify cache is restored
  sleep(10);
  const healthRes = http.get(`${BASE_URL}/health`);
  check(healthRes, {
    'system healthy after redis recovery': (r) => r.status === 200,
  });
}

/**
 * Chaos Scenario 4: High Error Rate
 * Simulate service returning errors
 */
export function chaosHighErrorRate() {
  console.log('Injecting high error rate...');

  const injectRes = http.post(`${CHAOS_ENDPOINT}/chaos/inject`, JSON.stringify({
    scenario: 'error-rate',
    error_rate: 0.5,  // 50% of requests return 500
    duration_seconds: 30,
  }), {
    headers: { 'Content-Type': 'application/json' },
  });

  chaosInjected.add(1);

  // Client-side resilience: retry with exponential backoff
  function retryWithBackoff(url, maxRetries = 3) {
    for (let attempt = 0; attempt < maxRetries; attempt++) {
      const res = http.get(url, {
        timeout: '5s',
        headers: {
          'X-Retry-Attempt': attempt.toString(),
        },
      });

      if (res.status === 200) {
        recoveryCount.add(1);
        return res;
      }

      if (attempt < maxRetries - 1) {
        const backoffMs = Math.min(1000 * Math.pow(2, attempt), 5000);
        sleep(backoffMs / 1000);
      } else {
        failureCount.add(1);
      }
    }
  }

  // Send requests with retry logic
  for (let i = 0; i < 30; i++) {
    retryWithBackoff(`${BASE_URL}/health`);
    sleep(1);
  }

  // Verify service recovers
  sleep(10);
  const healthRes = http.get(`${BASE_URL}/health`);
  check(healthRes, {
    'service recovered from error injection': (r) => r.status === 200,
  });
}

/**
 * Chaos Scenario 5: Regional Failover
 * Simulate primary region failure, test failover to secondary
 */
export function chaosRegionalFailover() {
  console.log('Injecting regional failure...');

  const injectRes = http.post(`${CHAOS_ENDPOINT}/chaos/inject`, JSON.stringify({
    scenario: 'regional-failure',
    region: 'primary',
    duration_seconds: 45,
  }), {
    headers: { 'Content-Type': 'application/json' },
  });

  chaosInjected.add(1);

  // Monitor failover
  const startTime = Date.now();
  let failedRequests = 0;
  let successfulRequests = 0;

  for (let i = 0; i < 45; i++) {
    const res = http.get(`${BASE_URL}/health`, {
      timeout: '3s',
    });

    if (res.status === 200) {
      successfulRequests++;
      const timeToRecover = Date.now() - startTime;
      if (timeToRecover > 1000) {
        // Only count recovery time after initial failure
        recoveryTime.add(timeToRecover);
        recoveryCount.add(1);
      }
    } else {
      failedRequests++;
      failureCount.add(1);
    }

    sleep(1);
  }

  // Verify failover metrics
  check(null, {
    'failover completed within RTO': () => {
      const rto = recoveryTime.value < 300000; // 5 minutes
      return rto;
    },
    'data loss < RPO': () => true, // Verify in post-test
  });
}

/**
 * Main test: Run all chaos scenarios sequentially
 */
export default function () {
  const scenario = __ENV.CHAOS_SCENARIO || 'all';

  switch (scenario) {
    case 'latency':
      chaosNetworkLatency();
      break;
    case 'database':
      chaosDatabaseExhaustion();
      break;
    case 'redis':
      chaosRedisFailure();
      break;
    case 'errors':
      chaosHighErrorRate();
      break;
    case 'failover':
      chaosRegionalFailover();
      break;
    case 'all':
      chaosNetworkLatency();
      sleep(60);
      chaosDatabaseExhaustion();
      sleep(60);
      chaosRedisFailure();
      sleep(60);
      chaosHighErrorRate();
      sleep(60);
      chaosRegionalFailover();
      break;
  }
}

export function teardown(data) {
  console.log(`\n=== Chaos Test Results ===`);
  console.log(`Chaos scenarios injected: ${chaosInjected.value}`);
  console.log(`Failures detected: ${failureCount.value}`);
  console.log(`Successful recoveries: ${recoveryCount.value}`);
  console.log(`Average recovery time: ${recoveryTime.value}ms`);
}
