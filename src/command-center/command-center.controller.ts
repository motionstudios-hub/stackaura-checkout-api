import { Controller, Get, Req, UseGuards } from '@nestjs/common';
import { Request } from 'express';
import { CommandCenterService } from './command-center.service';
import { SessionAuthGuard } from '../auth/session-auth.guard';

@Controller('command-center')
@UseGuards(SessionAuthGuard)
export class CommandCenterController {
  constructor(private readonly commandCenterService: CommandCenterService) {}

  @Get('overview')
  async getOverview(@Req() req: Request) {
    const session = (req as Request & { session?: { userId: string } }).session;
    return this.commandCenterService.getOverview(session?.userId);
  }
}
