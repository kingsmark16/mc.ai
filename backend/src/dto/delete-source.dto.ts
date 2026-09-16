import { IsNotEmpty, IsString, MaxLength } from 'class-validator';

export class DeleteSourceDto {
  @IsString()
  @IsNotEmpty()
  @MaxLength(255)
  source!: string;
}
