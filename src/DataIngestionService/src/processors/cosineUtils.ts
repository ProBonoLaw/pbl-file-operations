import { dot, Matrix, norm, row } from 'mathjs';

// Cosine similarity function
export function cosineSimilarity(X: Matrix, Y: Matrix): number[][] {
  const [rowsX] = X.size();
  const [rowsY] = Y.size();

  const similarityArray: number[][] = [];

  for (let i = 0; i < rowsX; i++) {
    const rowX = row(X, i).toArray()[0] as number[];
    const normX = norm(rowX, 2) as number; // Typically cosine similarity uses L2 norm

    const rowSimilarity: number[] = [];

    for (let j = 0; j < rowsY; j++) {
      const rowY = row(Y, j).toArray()[0] as number[];
      const normY = norm(rowY, 2) as number;

      const dotProduct = dot(rowX, rowY) as number;
      const similarity =
        normX === 0 || normY === 0 ? 0 : dotProduct / (normX * normY);

      rowSimilarity.push(similarity);
    }
    similarityArray.push(rowSimilarity);
  }

  return similarityArray;
}
  


// Cosine similarity with top-k filtering
export function cosineSimilarityTopK(
    X: Matrix,
    Y: Matrix,
    topK: number = 5,
    scoreThreshold: number = -1
  ): [Array<[number, number]>, number[]] {
    if (X.size()[0] === 0 || Y.size()[0] === 0) {
      return [[], []];
    }
  
    const scoreArray = cosineSimilarity(X, Y);
  
    const flatScores: { score: number; indexX: number; indexY: number }[] = [];
  
    scoreArray.forEach((row, i) => {
      row.forEach((score, j) => {
        if (score >= scoreThreshold) {
          flatScores.push({ score, indexX: i, indexY: j });
        }
      });
    });
  
    flatScores.sort((a, b) => b.score - a.score);
    const topResults = flatScores.slice(0, topK);
  
    const topKIndices: Array<[number, number]> = topResults.map(
      ({ indexX, indexY }) => [indexX, indexY]
    );
    const topKScores: number[] = topResults.map(({ score }) => score);
  
    return [topKIndices, topKScores];
  }