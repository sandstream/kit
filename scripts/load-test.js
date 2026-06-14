import http from 'k6/http';
import { check, group, sleep } from 'k6';
import { Rate, Trend, Counter, Gauge } from 'k6/metrics';

// Custom metrics
const httpReqDuration = new Trend('http_req_duration');
const httpReqFailed = new Counter('http_req_failed');
const httpReqSuccess = new Counter('http_req_success');
const connectedUsers = new Gauge('connected_users');
const avgResponseTime = new Trend('avg_response_time');
const p95ResponseTime = new Trend('p95_response_time');
const errorRate = new Rate('error_rate');

// Load test configuration
export const options = {
  stages: [
    { duration: '1m', target: 10 },    // Ramp up to 10 VUs
    { duration: '3m', target: 50 },    // Ramp up to 50 VUs
    { duration: '5m', target: 100 },   // Ramp up to 100 VUs (peak)
    { duration: '3m', target: 50 },    // Ramp down to 50 VUs
    { duration: '1m', target: 0 },     // Ramp down to 0 VUs
  ],
  thresholds: {
    http_req_duration: ['p(95)<500', 'p(99)<1000'],  // 95% under 500ms, 99% under 1s
    http_req_failed: ['rate<0.1'],                    // Error rate < 10%
    error_rate: ['rate<0.1'],
  },
};

const BASE_URL = __ENV.BASE_URL || 'http://localhost:8000';

export default function () {
  connectedUsers.add(__VU);

  group('API Health Check', () => {
    const healthRes = http.get(`${BASE_URL}/health`, {
      tags: { name: 'Health' },
    });

    const isHealthy = check(healthRes, {
      'health status 200': (r) => r.status === 200,
      'health response time < 100ms': (r) => r.timings.duration < 100,
    });

    if (!isHealthy) {
      httpReqFailed.add(1);
      errorRate.add(true);
    } else {
      httpReqSuccess.add(1);
      errorRate.add(false);
    }
  });

  group('List Plugins', () => {
    const pluginsRes = http.get(`${BASE_URL}/api/plugins`, {
      tags: { name: 'ListPlugins' },
    });

    const success = check(pluginsRes, {
      'list plugins status 200': (r) => r.status === 200,
      'plugins list not empty': (r) => JSON.parse(r.body).length > 0,
      'response time < 500ms': (r) => r.timings.duration < 500,
    });

    httpReqDuration.add(pluginsRes.timings.duration);
    avgResponseTime.add(pluginsRes.timings.duration);
    p95ResponseTime.add(pluginsRes.timings.duration);

    if (!success) {
      httpReqFailed.add(1);
      errorRate.add(true);
    } else {
      httpReqSuccess.add(1);
      errorRate.add(false);
    }
  });

  group('Create Plugin', () => {
    const payload = JSON.stringify({
      name: `test-plugin-${Date.now()}`,
      description: 'Load test plugin',
      version: '1.0.0',
    });

    const params = {
      headers: {
        'Content-Type': 'application/json',
      },
      tags: { name: 'CreatePlugin' },
    };

    const createRes = http.post(`${BASE_URL}/api/plugins`, payload, params);

    const success = check(createRes, {
      'create plugin status 201': (r) => r.status === 201,
      'created plugin has id': (r) => JSON.parse(r.body).id !== undefined,
      'response time < 1000ms': (r) => r.timings.duration < 1000,
    });

    httpReqDuration.add(createRes.timings.duration);

    if (!success) {
      httpReqFailed.add(1);
      errorRate.add(true);
    } else {
      httpReqSuccess.add(1);
      errorRate.add(false);
    }
  });

  group('Authenticate User', () => {
    const authPayload = JSON.stringify({
      email: `user-${__VU}-${Date.now()}@test.com`,
      password: 'testpassword123',
    });

    const authParams = {
      headers: {
        'Content-Type': 'application/json',
      },
      tags: { name: 'Authenticate' },
    };

    const authRes = http.post(`${BASE_URL}/api/auth/register`, authPayload, authParams);

    const success = check(authRes, {
      'auth status 200 or 201': (r) => r.status === 200 || r.status === 201,
      'auth response time < 500ms': (r) => r.timings.duration < 500,
    });

    if (!success) {
      httpReqFailed.add(1);
      errorRate.add(true);
    } else {
      httpReqSuccess.add(1);
      errorRate.add(false);
    }
  });

  group('Rate Limit Stress', () => {
    // Send rapid requests to test rate limiting
    for (let i = 0; i < 5; i++) {
      const res = http.get(`${BASE_URL}/health`, {
        tags: { name: 'RateLimitTest' },
      });

      if (res.status === 429) {
        // Rate limited - expected behavior
        check(res, {
          'rate limit status 429': (r) => r.status === 429,
          'retry-after header present': (r) => r.headers['Retry-After'] !== undefined,
        });
      }
    }
  });

  sleep(1);
}

export function teardown(data) {
  console.log(`Test completed. Error rate: ${data.error_rate}%`);
}
