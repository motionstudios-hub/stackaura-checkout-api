import { Controller, Get } from '@nestjs/common';
import { AppService } from './app.service';

@Controller()
export class AppController {
  constructor(private readonly appService: AppService) {}

  // Keep the default root route for now
  @Get()
  getHello(): string {
    return this.appService.getHello();
  }

  // Health endpoint for uptime checks
  @Get('health')
  health() {
    return {
      status: 'ok',
      service: 'checkout-api',
      timestamp: new Date().toISOString(),
    };
  }
}
