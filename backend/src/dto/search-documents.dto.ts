import { IsNotEmpty, IsString, MaxLength } from 'class-validator';

export class SearchDocumentsDto {
  @IsString()
  @IsNotEmpty()
  @MaxLength(2_000)
  query!: string;
}
