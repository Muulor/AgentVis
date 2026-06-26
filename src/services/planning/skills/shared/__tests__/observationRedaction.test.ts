import { describe, expect, it } from 'vitest';
import { redactSensitiveObservation } from '../observationRedaction';

describe('redactSensitiveObservation', () => {
    it('redacts broker tokens and proxy environment values', () => {
        const output = redactSensitiveObservation(
            [
                'AGENTVIS_BROKER_TOKEN=secret-token',
                'HTTP_PROXY=http://agentvis:proxy-token@127.0.0.1:49152',
                'AGENTVIS_NETWORK_PROXY_URL=http://agentvis:proxy-token@127.0.0.1:49152',
                'AGENTVIS_BROWSER_PROXY_PASSWORD=proxy-token',
            ].join('\n')
        );

        expect(output).not.toContain('secret-token');
        expect(output).not.toContain('proxy-token');
        expect(output).not.toContain('49152');
        expect(output).toContain('AGENTVIS_BROKER_TOKEN=');
        expect(output).toContain('HTTP_PROXY=');
    });

    it('redacts common credential headers and fields', () => {
        const output = redactSensitiveObservation(
            [
                'Authorization: Bearer abc123',
                'Proxy-Authorization: Basic abc123',
                'Cookie: sid=secret',
                'Set-Cookie: refresh=secret',
                'api_key=sk-test',
                '"access_token": "tok-value"',
            ].join('\n')
        );

        expect(output).not.toContain('abc123');
        expect(output).not.toContain('sid=secret');
        expect(output).not.toContain('refresh=secret');
        expect(output).not.toContain('sk-test');
        expect(output).not.toContain('tok-value');
    });

    it('redacts common secret query parameters', () => {
        const output = redactSensitiveObservation(
            'GET https://api.example.com/search?q=public&token=secret-token&api_key=secret-key&sig=secret-signature'
        );

        expect(output).toContain('q=public');
        expect(output).not.toContain('secret-token');
        expect(output).not.toContain('secret-key');
        expect(output).not.toContain('secret-signature');
    });

    it('redacts bare loopback proxy URLs from verbose tool output', () => {
        const output = redactSensitiveObservation(
            [
                "* Uses proxy env variable https_proxy == 'http://127.0.0.1:55143'",
                'Proxy used: http://localhost:57402',
                'CONNECT tunnel established via http://[::1]:50123',
            ].join('\n')
        );

        expect(output).not.toContain('55143');
        expect(output).not.toContain('57402');
        expect(output).not.toContain('50123');
        expect(output).not.toContain('http://127.0.0.1');
        expect(output).not.toContain('http://localhost');
    });

    it('redacts credential URLs from proxy and browser logs', () => {
        const output = redactSensitiveObservation(
            [
                'Launching browser with proxy http://agentvis:proxy-token@proxy.example.com:8080',
                'CONNECT via https://user:secret@example.com/path',
            ].join('\n')
        );

        expect(output).not.toContain('proxy-token');
        expect(output).not.toContain('user:secret');
        expect(output).not.toContain('agentvis:');
        expect(output).not.toContain('http://agentvis');
        expect(output).not.toContain('https://user');
    });
});
