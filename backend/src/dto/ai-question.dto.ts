import { IsNotEmpty, IsString, MaxLength } from 'class-validator';

export class AiQuestionDto {
  @IsString()
  @IsNotEmpty()
  @MaxLength(2_000)
  question!: string;
}
