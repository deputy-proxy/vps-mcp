import { expect, it, vi } from 'vitest';
import { registerProjectEnvironmentWithReservation } from './project-environment-admission.js';

const input = { repositoryId: 'acme-demo-a1b2c3d4e5', profileId: 'laravel-php' };
const environment = {
  repositoryId: input.repositoryId,
  resources: { cpuMilli: 500, memoryMiB: 1024, pids: 128, diskMiB: 10240 },
};

it('reserves the registered profile vector and clears any previous admission error', async () => {
  const register = vi.fn().mockResolvedValue({ created: true, environment });
  const reserve = vi.fn().mockResolvedValue({ reservation: { status: 'reserved' }, unchanged: false });
  const update = vi.fn().mockResolvedValue({});

  const result = await registerProjectEnvironmentWithReservation(input, { register, reserve, update });

  expect(register).toHaveBeenCalledWith(input);
  expect(reserve).toHaveBeenCalledWith({ repositoryId: input.repositoryId, resources: environment.resources });
  expect(update).toHaveBeenCalledWith({ repositoryId: input.repositoryId, lastError: null });
  expect(result.reservation).toMatchObject({ reservation: { status: 'reserved' } });
});

it('keeps metadata visible and records the reservation failure for safe retry', async () => {
  const register = vi.fn().mockResolvedValue({ created: true, environment });
  const reserve = vi.fn().mockRejectedValue(new Error('SANDBOX_CAPACITY_EXCEEDED: global memory reservation budget would be exceeded'));
  const update = vi.fn().mockResolvedValue({});

  await expect(registerProjectEnvironmentWithReservation(input, { register, reserve, update }))
    .rejects.toThrow('metadata is registered, but resource reservation failed: SANDBOX_CAPACITY_EXCEEDED');
  expect(update).toHaveBeenCalledWith({
    repositoryId: input.repositoryId,
    lastError: 'Resource reservation failed: SANDBOX_CAPACITY_EXCEEDED: global memory reservation budget would be exceeded',
  });
});

it('retries reservation for an already registered environment', async () => {
  const register = vi.fn().mockResolvedValue({ created: false, environment });
  const reserve = vi.fn().mockResolvedValue({ unchanged: true });
  const update = vi.fn().mockResolvedValue({});

  const result = await registerProjectEnvironmentWithReservation(input, { register, reserve, update });

  expect(register).toHaveBeenCalledTimes(1);
  expect(reserve).toHaveBeenCalledTimes(1);
  expect(result.created).toBe(false);
  expect(result.reservation).toEqual({ unchanged: true });
});
