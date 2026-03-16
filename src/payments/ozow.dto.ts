import { Transform } from 'class-transformer';
import {
  IsEmail,
  IsIn,
  IsInt,
  IsOptional,
  IsString,
  MaxLength,
  Min,
} from 'class-validator';

const trim = (value: unknown) =>
  typeof value === 'string' ? value.trim() : value;
const trimUpper = (value: unknown) =>
  typeof value === 'string' ? value.trim().toUpperCase() : value;

export class InitiateOzowPaymentDto {
  @IsInt()
  @Min(1)
  amountCents!: number;

  @Transform(({ value }) => trimUpper(value as unknown))
  @IsOptional()
  @IsString()
  @IsIn(['ZAR'])
  currency?: 'ZAR';

  @Transform(({ value }) => trim(value))
  @IsOptional()
  @IsString()
  @MaxLength(50)
  reference?: string;

  @Transform(({ value }) => trim(value))
  @IsOptional()
  @IsString()
  @MaxLength(20)
  bankReference?: string;

  @Transform(({ value }) => trim(value))
  @IsOptional()
  @IsEmail()
  @MaxLength(100)
  customerEmail?: string;

  @Transform(({ value }) => trim(value))
  @IsOptional()
  @IsString()
  @MaxLength(255)
  description?: string;
}
