import { IsNotEmpty, IsString, MaxLength } from 'class-validator';

export class AddDocumentDto {
  @IsString()
  @IsNotEmpty()
  @MaxLength(100_000)
  text!: string;
}
