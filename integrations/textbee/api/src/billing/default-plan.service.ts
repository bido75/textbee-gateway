import { Injectable, Logger, OnModuleInit } from '@nestjs/common'
import { InjectModel } from '@nestjs/mongoose'
import { Model } from 'mongoose'
import { Plan, PlanDocument } from './schemas/plan.schema'

@Injectable()
export class DefaultPlanService implements OnModuleInit {
  private readonly logger = new Logger(DefaultPlanService.name)

  constructor(
    @InjectModel(Plan.name) private readonly planModel: Model<PlanDocument>,
  ) {}

  async onModuleInit() {
    const selfHosted = process.env.TEXTBEE_SELF_HOSTED === 'true'
    const unlimited = selfHosted ? -1 : undefined

    const result = await this.planModel.updateOne(
      { name: 'free' },
      {
        $setOnInsert: {
          name: 'free',
          dailyLimit: unlimited ?? 50,
          monthlyLimit: unlimited ?? 500,
          bulkSendLimit: unlimited ?? 50,
          deviceLimit: unlimited ?? 1,
          monthlyPrice: 0,
          yearlyPrice: 0,
          isActive: true,
        },
      },
      { upsert: true },
    )

    if (result.upsertedCount > 0) {
      this.logger.log(
        `Created ${selfHosted ? 'unlimited self-hosted' : 'default'} free plan`,
      )
    }
  }
}

