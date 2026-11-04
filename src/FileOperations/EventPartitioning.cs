using System.Buffers.Binary;
using System.Security.Cryptography;
using System.Text;

namespace FileOperations;

public static class EventPartitioning
{
    public static string ForSource(string accountId, string sourceId) =>
        Convert.ToHexString(Hash(accountId, sourceId));

    public static int ShardForSource(string accountId, string sourceId, int shardCount) =>
        (int)(BinaryPrimitives.ReadUInt32BigEndian(Hash(accountId, sourceId)) % (uint)shardCount);

    private static byte[] Hash(string accountId, string sourceId) =>
        SHA256.HashData(Encoding.UTF8.GetBytes(accountId + "\0" + sourceId));
}
