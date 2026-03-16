import { Transform } from 'class-transformer';
import {
  IsIn,
  IsInt,
  IsNotEmpty,
  IsOptional,
  IsString,
  MaxLength,
  Min,
} from 'class-validator';

const trim = (value: unknown) =>
  typeof value === 'string' ? value.trim() : value;
const trimUpper = (value: unknown) =>
  typeof value === 'string' ? value.trim().toUpperCase() : value;

export class CreatePayoutDto {
  @IsInt()
  @Min(1)
  amountCents!: number;

  @Transform(({ value }) => trimUpper(value as unknown))
  @IsString()
  @IsIn(['ZAR'])
  currency!: 'ZAR';

  @Transform(({ value }) => trim(value))
  @IsString()
  @IsNotEmpty()
  @MaxLength(120)
  reference!: string;

  @Transform(({ value }) => trimUpper(value as unknown))
  @IsString()
  @IsIn(['DERIV'])
  rail!: 'DERIV';

  @Transform(({ value }) => trim(value))
  @IsString()
  @IsNotEmpty()
  @MaxLength(64)
  derivAccountId!: string;

  @Transform(({ value }) => trim(value))
  @IsOptional()
  @IsString()
  @MaxLength(120)
  beneficiaryName?: string;
}
