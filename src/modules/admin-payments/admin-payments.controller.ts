import {
  Controller,
  Get,
  Param,
  Query,
  UseGuards,
  ParseIntPipe,
  Logger,
} from '@nestjs/common';
import { ApiTags, ApiOperation, ApiBearerAuth, ApiQuery } from '@nestjs/swagger';
import { AdminPaymentsService } from './admin-payments.service';
import { JwtAuthGuard } from '../../auth/guards/jwt-auth.guard';
import { AdminGuard } from '../../auth/guards/admin.guard';

@ApiTags('Admin Payments')
@Controller('admin/payments')
@UseGuards(JwtAuthGuard, AdminGuard)
@ApiBearerAuth()
export class AdminPaymentsController {
  private readonly logger = new Logger(AdminPaymentsController.name);
  
  constructor(private readonly adminPaymentsService: AdminPaymentsService) {}

  @Get('order/:order_id')
  @ApiOperation({ summary: 'Get payment status for an order' })
  async getPaymentStatus(@Param('order_id', ParseIntPipe) orderId: number) {
    return this.adminPaymentsService.getPaymentStatus(orderId);
  }

  @Get('history')
  @ApiOperation({ summary: 'Get payment history with filters' })
  @ApiQuery({ name: 'order_id', required: false, type: Number })
  @ApiQuery({ name: 'customer_id', required: false, type: Number })
  @ApiQuery({ name: 'payment_status', required: false, type: String })
  @ApiQuery({ name: 'payment_gateway', required: false, type: String })
  @ApiQuery({ name: 'date_from', required: false, type: String })
  @ApiQuery({ name: 'date_to', required: false, type: String })
  @ApiQuery({ name: 'limit', required: false, type: Number })
  @ApiQuery({ name: 'offset', required: false, type: Number })
  async getPaymentHistory(
    @Query('order_id') orderId?: string,
    @Query('customer_id') customerId?: string,
    @Query('payment_status') paymentStatus?: string,
    @Query('payment_gateway') paymentGateway?: string,
    @Query('date_from') dateFrom?: string,
    @Query('date_to') dateTo?: string,
    @Query('limit') limit?: string,
    @Query('offset') offset?: string,
  ) {
    return this.adminPaymentsService.getPaymentHistory({
      order_id: orderId ? parseInt(orderId) : undefined,
      customer_id: customerId ? parseInt(customerId) : undefined,
      payment_status: paymentStatus,
      payment_gateway: paymentGateway,
      date_from: dateFrom,
      date_to: dateTo,
      limit: limit ? parseInt(limit) : 50,
      offset: offset ? parseInt(offset) : 0,
    });
  }

  @Get('history/:order_id')
  @ApiOperation({ summary: 'Get order payment history' })
  async getOrderPaymentHistory(@Param('order_id', ParseIntPipe) orderId: number) {
    return this.adminPaymentsService.getOrderPaymentHistoryPublic(orderId);
  }

  @Get('audit/:transaction_id')
  @ApiOperation({ summary: 'Get payment audit log for a transaction' })
  async getPaymentAuditLog(@Param('transaction_id') transactionId: string) {
    return this.adminPaymentsService.getPaymentAuditLog(transactionId);
  }

  @Get('statistics')
  @ApiOperation({ summary: 'Get payment statistics' })
  @ApiQuery({ name: 'date_from', required: false, type: String })
  @ApiQuery({ name: 'date_to', required: false, type: String })
  async getPaymentStatistics(
    @Query('date_from') dateFrom?: string,
    @Query('date_to') dateTo?: string,
  ) {
    return this.adminPaymentsService.getPaymentStatistics(dateFrom, dateTo);
  }
}
