type ResourceVector = { cpuMilli: number; memoryMiB: number; pids: number; diskMiB: number };

type RegistrationResult<TEnvironment> = { created: boolean; environment: TEnvironment };

/**
 * Persist the environment identity first, then acquire its durable capacity
 * reservation. A reservation failure leaves a visible metadata-only record with
 * lastError set; retrying registration safely retries the idempotent reservation.
 */
export async function registerProjectEnvironmentWithReservation<
  TInput extends { repositoryId: string },
  TEnvironment extends { repositoryId: string; resources: ResourceVector },
  TResult extends RegistrationResult<TEnvironment>,
  TReservation,
>(
  input: TInput,
  dependencies: {
    register: (input: TInput) => Promise<TResult>;
    reserve: (input: { repositoryId: string; resources: ResourceVector }) => Promise<TReservation>;
    update: (input: { repositoryId: string; lastError: string | null }) => Promise<unknown>;
  },
): Promise<TResult & { reservation: TReservation }> {
  const registered = await dependencies.register(input);
  let reservation: TReservation;
  try {
    reservation = await dependencies.reserve({
      repositoryId: registered.environment.repositoryId,
      resources: registered.environment.resources,
    });
  } catch (error) {
    const reason = error instanceof Error ? error.message : 'Unknown resource reservation error';
    await dependencies.update({
      repositoryId: registered.environment.repositoryId,
      lastError: `Resource reservation failed: ${reason}`,
    }).catch(() => undefined);
    throw new Error(`Project environment metadata is registered, but resource reservation failed: ${reason}`);
  }
  await dependencies.update({ repositoryId: registered.environment.repositoryId, lastError: null });
  return { ...registered, reservation };
}
