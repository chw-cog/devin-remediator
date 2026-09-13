import { Config, ConfigProvider, Effect } from "effect";

export type Env = Record<string, string | undefined>;

export const AppConfig = Config.all({
  devinApiKey: Config.String("DEVIN_API_KEY"),
  devinOrganizationId: Config.String("DEVIN_ORGANIZATION_ID"),
});

export type AppConfig = Config.Success<typeof AppConfig>;

export function withConfig<A, E, R>(
  env: Env,
  f: (config: AppConfig) => Effect.Effect<A, E, R>,
) {
  return AppConfig.pipe(
    Effect.flatMap(f),
    Effect.provideService(
      ConfigProvider.ConfigProvider,
      ConfigProvider.fromUnknown(env),
    ),
  );
}
