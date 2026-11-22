import { Global, Module } from '@nestjs/common';
import { config as loadDotenv } from 'dotenv';
import { AppConfig } from './app-config.js';

@Global()
@Module({
  providers: [
    {
      provide: AppConfig,
      useFactory: () => {
        // Values already present in the environment win over .env (dotenv default).
        loadDotenv({ quiet: true });
        return new AppConfig(process.env);
      },
    },
  ],
  exports: [AppConfig],
})
export class AppConfigModule {}
