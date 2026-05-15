import { Injectable, Logger, BadRequestException, NotFoundException } from '@nestjs/common';
import { DataSource } from 'typeorm';
import { ConfigService } from '@nestjs/config';
import * as crypto from 'crypto';
import axios from 'axios';
import { EmailService } from '../../common/services/email.service';

@Injectable()
export class AdminPaymentsService {
  private readonly logger = new Logger(AdminPaymentsService.name);

  constructor(
    private dataSource: DataSource,
    private emailService: EmailService,
    private configService: ConfigService,
  ) { }


  /**
   * Payment History Service methods
   */
  async recordPayment(record: any): Promise<number> {
    const queryRunner = this.dataSource.createQueryRunner();
    await queryRunner.connect();
    await queryRunner.startTransaction();

    try {
      const result = await queryRunner.query(
        `INSERT INTO payment_history (
          order_id, payment_transaction_id, payment_type, payment_status,
          payment_gateway, amount, currency, gateway_response, request_id, idempotency_key,
          customer_email, customer_id, card_token, payment_method, ip_address, user_agent, metadata
        ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, $17)
        RETURNING payment_history_id`,
        [
          record.order_id, record.payment_transaction_id, record.payment_type,
          record.payment_status, record.payment_gateway, record.amount,
          record.currency || 'AUD', JSON.stringify(record.gateway_response),
          record.request_id || crypto.randomUUID(), record.idempotency_key || crypto.randomUUID(),
          record.customer_email, record.customer_id, record.card_token,
          record.payment_method, record.ip_address, record.user_agent,
          record.metadata ? JSON.stringify(record.metadata) : null
        ]
      );
      await queryRunner.commitTransaction();
      return result[0].payment_history_id;
    } catch (error) {
      await queryRunner.rollbackTransaction();
      throw error;
    } finally {
      await queryRunner.release();
    }
  }

  async updatePaymentStatus(transactionId: string, status: string, gatewayResponse?: any, gatewayError?: any): Promise<void> {
    await this.dataSource.query(
      `UPDATE payment_history 
       SET payment_status = $1, gateway_response = COALESCE($2::jsonb, gateway_response),
           gateway_error = COALESCE($3::jsonb, gateway_error), updated_at = CURRENT_TIMESTAMP
       WHERE payment_transaction_id = $4`,
      [status, gatewayResponse ? JSON.stringify(gatewayResponse) : null, gatewayError ? JSON.stringify(gatewayError) : null, transactionId]
    );
  }

  async getOrderPaymentHistory(orderId: number): Promise<any[]> {
    const result = await this.dataSource.query(
      `SELECT * FROM payment_history WHERE order_id = $1 ORDER BY created_at DESC`,
      [orderId]
    );
    return result;
  }

  async getPaymentByTransactionId(transactionId: string): Promise<any | null> {
    const result = await this.dataSource.query(
      'SELECT * FROM payment_history WHERE payment_transaction_id = $1',
      [transactionId]
    );
    return result[0] || null;
  }

  static sanitizePaymentResponse(response: any): any {
    if (!response) return null;
    const sanitized = { ...response };
    if (sanitized.response?.card) {
      delete sanitized.response.card.number;
      delete sanitized.response.card.cvc;
    }
    return sanitized;
  }

  /**
   * Get payment status for an order
   */
  async getPaymentStatus(orderId: number) {
    const query = `
      SELECT 
        order_id,
        payment_transaction_id,
        payment_status,
        payment_gateway,
        payment_date,
        payment_response
      FROM orders
      WHERE order_id = $1
    `;
    const result = await this.dataSource.query(query, [orderId]);

    if (result.length === 0) {
      throw new NotFoundException('Order not found');
    }

    const order = result[0];

    return {
      order_id: order.order_id,
      payment_transaction_id: order.payment_transaction_id,
      payment_status: order.payment_status,
      payment_gateway: order.payment_gateway,
      payment_date: order.payment_date,
      payment_response: order.payment_response
    };
  }

  /**
   * Get payment history with filters
   */
  async getPaymentHistory(filters: {
    order_id?: number;
    customer_id?: number;
    payment_status?: string;
    payment_gateway?: string;
    date_from?: string;
    date_to?: string;
    limit?: number;
    offset?: number;
  }) {
    const {
      order_id,
      customer_id,
      payment_status,
      payment_gateway,
      date_from,
      date_to,
      limit = 50,
      offset = 0,
    } = filters;

    let query = `
      SELECT 
        ph.payment_history_id,
        ph.order_id,
        ph.payment_transaction_id,
        ph.payment_type,
        ph.payment_status,
        ph.payment_gateway,
        ph.amount,
        ph.currency,
        ph.refund_amount,
        ph.customer_id,
        ph.customer_email,
        ph.card_last4,
        ph.card_brand,
        ph.payment_method,
        ph.created_at,
        ph.updated_at,
        ph.processed_at,
        ph.gateway_response->>'status' as gateway_status,
        ph.gateway_response->>'message' as gateway_message,
        CASE 
          WHEN ph.gateway_error IS NOT NULL THEN true
          ELSE false
        END as has_error,
        o.order_total,
        o.order_status,
        c.firstname || ' ' || c.lastname as customer_name
      FROM payment_history ph
      LEFT JOIN orders o ON ph.order_id = o.order_id
      LEFT JOIN customer c ON ph.customer_id = c.customer_id
      WHERE 1=1
    `;
    const params: any[] = [];
    let paramIndex = 1;

    if (order_id) {
      query += ` AND ph.order_id = $${paramIndex}`;
      params.push(order_id);
      paramIndex++;
    }

    if (customer_id) {
      query += ` AND ph.customer_id = $${paramIndex}`;
      params.push(customer_id);
      paramIndex++;
    }

    if (payment_status) {
      query += ` AND ph.payment_status = $${paramIndex}`;
      params.push(payment_status);
      paramIndex++;
    }

    if (payment_gateway) {
      query += ` AND ph.payment_gateway = $${paramIndex}`;
      params.push(payment_gateway);
      paramIndex++;
    }

    if (date_from) {
      query += ` AND ph.created_at >= $${paramIndex}`;
      params.push(date_from);
      paramIndex++;
    }

    if (date_to) {
      query += ` AND ph.created_at <= $${paramIndex}`;
      params.push(date_to + ' 23:59:59');
      paramIndex++;
    }

    query += ` ORDER BY ph.created_at DESC`;
    query += ` LIMIT $${paramIndex} OFFSET $${paramIndex + 1}`;
    params.push(Math.min(limit, 500));
    params.push(offset);

    const result = await this.dataSource.query(query, params);

    // Get total count
    let countQuery = `
      SELECT COUNT(*) as total
      FROM payment_history ph
      WHERE 1=1
    `;
    const countParams: any[] = [];
    let countParamIndex = 1;

    if (order_id) {
      countQuery += ` AND ph.order_id = $${countParamIndex}`;
      countParams.push(order_id);
      countParamIndex++;
    }

    if (customer_id) {
      countQuery += ` AND ph.customer_id = $${countParamIndex}`;
      countParams.push(customer_id);
      countParamIndex++;
    }

    if (payment_status) {
      countQuery += ` AND ph.payment_status = $${countParamIndex}`;
      countParams.push(payment_status);
      countParamIndex++;
    }

    if (payment_gateway) {
      countQuery += ` AND ph.payment_gateway = $${countParamIndex}`;
      countParams.push(payment_gateway);
      countParamIndex++;
    }

    if (date_from) {
      countQuery += ` AND ph.created_at >= $${countParamIndex}`;
      countParams.push(date_from);
      countParamIndex++;
    }

    if (date_to) {
      countQuery += ` AND ph.created_at <= $${countParamIndex}`;
      countParams.push(date_to + ' 23:59:59');
      countParamIndex++;
    }

    const countResult = await this.dataSource.query(countQuery, countParams);
    const total = parseInt(countResult[0].total);

    return {
      payments: result,
      pagination: {
        total,
        limit,
        offset,
        has_more: total > offset + limit,
      },
    };
  }

  /**
   * Get order payment history (public method that sanitizes)
   */
  async getOrderPaymentHistoryPublic(orderId: number) {
    const payments = await this.getOrderPaymentHistory(orderId);

    // Sanitize sensitive data
    const sanitizedPayments = payments.map((payment: any) => ({
      ...payment,
      gateway_response: AdminPaymentsService.sanitizePaymentResponse(payment.gateway_response)
    }));

    return { payments: sanitizedPayments };
  }

  /**
   * Get payment audit log
   */
  async getPaymentAuditLog(transactionId: string) {
    const query = `
      SELECT 
        pal.*,
        ph.order_id,
        ph.amount,
        ph.currency
      FROM payment_audit_log pal
      JOIN payment_history ph ON pal.payment_history_id = ph.payment_history_id
      WHERE pal.transaction_id = $1
      ORDER BY pal.created_at ASC
    `;

    const result = await this.dataSource.query(query, [transactionId]);

    return {
      audit_log: result,
    };
  }

  /**
   * Get payment statistics
   */
  async getPaymentStatistics(dateFrom?: string, dateTo?: string) {
    let dateFilter = '';
    const params: any[] = [];
    if (dateFrom && dateTo) {
      dateFilter = 'WHERE ph.created_at >= $1 AND ph.created_at <= $2';
      params.push(dateFrom, dateTo + ' 23:59:59');
    }

    const query = `
      SELECT 
        COUNT(*) as total_transactions,
        COUNT(CASE WHEN payment_status = 'succeeded' THEN 1 END) as successful_payments,
        COUNT(CASE WHEN payment_status = 'failed' THEN 1 END) as failed_payments,
        COUNT(CASE WHEN payment_status = 'pending' THEN 1 END) as pending_payments,
        COUNT(CASE WHEN payment_status = 'refunded' THEN 1 END) as refunded_payments,
        SUM(CASE WHEN payment_status = 'succeeded' THEN amount ELSE 0 END) as total_revenue,
        SUM(refund_amount) as total_refunds,
        SUM(CASE WHEN payment_status = 'succeeded' THEN amount ELSE 0 END) - COALESCE(SUM(refund_amount), 0) as net_revenue,
        COUNT(DISTINCT customer_id) as unique_customers,
        COUNT(DISTINCT order_id) as unique_orders
      FROM payment_history ph
      ${dateFilter}
    `;

    const result = await this.dataSource.query(query, params);

    return {
      statistics: result[0],
      period: {
        from: dateFrom || null,
        to: dateTo || null,
      },
    };
  }

  /**
   * Handle webhook
   */
  async handleWebhook(webhookData: any, signature?: string) {
    // Get webhook secret from settings
    const settingsQuery = `SELECT setting_value FROM settings WHERE setting_key = 'pinpayments_webhook_secret'`;
    const settingsResult = await this.dataSource.query(settingsQuery);
    const webhookSecret = settingsResult[0]?.setting_value || '';

    // Verify webhook signature (simplified - implement proper verification)
    // PinPayments webhook verification would go here

    const eventType = webhookData.type;
    const chargeData = webhookData.data;

    // Record webhook event in payment history
    if (chargeData?.token) {
      const existingPayment = await this.getPaymentByTransactionId(chargeData.token);

      if (existingPayment) {
        const newStatus = eventType.includes('succeeded') ? 'succeeded' :
          eventType.includes('failed') ? 'failed' :
            eventType.includes('refund') ? 'refunded' : 'pending';

        await this.updatePaymentStatus(
          chargeData.token,
          newStatus,
          webhookData,
          eventType.includes('failed') ? webhookData : undefined
        );
      }
    }

    // Find order by transaction ID
    const orderResult = await this.dataSource.query(
      'SELECT order_id, payment_response FROM orders WHERE payment_transaction_id = $1',
      [chargeData.token]
    );

    if (orderResult.length > 0) {
      const orderByTransaction = orderResult[0];

      if (eventType === 'charge.succeeded') {
        await this.dataSource.query(
          `UPDATE orders 
           SET payment_status = 'succeeded',
               payment_response = $1,
               payment_date = CURRENT_TIMESTAMP,
               order_status = 3
           WHERE payment_transaction_id = $2`,
          [JSON.stringify(AdminPaymentsService.sanitizePaymentResponse(webhookData)), chargeData.token]
        );
      } else if (eventType === 'charge.failed') {
        await this.dataSource.query(
          `UPDATE orders 
           SET payment_status = 'failed',
               payment_response = $1
           WHERE payment_transaction_id = $2`,
          [JSON.stringify(AdminPaymentsService.sanitizePaymentResponse(webhookData)), chargeData.token]
        );
      } else if (eventType === 'refund.succeeded') {
        const currentResponse = orderByTransaction.payment_response || {};
        await this.dataSource.query(
          `UPDATE orders 
           SET payment_status = 'refunded',
               payment_response = jsonb_set(
                 COALESCE(payment_response, '{}'::jsonb),
                 '{refund}',
                 $1::jsonb
               )
           WHERE payment_transaction_id = $2`,
          [JSON.stringify(AdminPaymentsService.sanitizePaymentResponse(chargeData)), chargeData.token]
        );
      }
    }

    return { received: true };
  }
}
