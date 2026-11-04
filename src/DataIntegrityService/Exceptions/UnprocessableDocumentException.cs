namespace DaatPhoenix.DataIntegrity.AI.DataIntegrity.Exceptions
{
	using System;

    [Serializable]
    public class UnprocessableDocumentException : Exception
    {
        public UnprocessableDocumentException() { }

        public UnprocessableDocumentException(string? message)
            : base(message) { }

        public UnprocessableDocumentException(string? message, Exception? innerException)
            : base(message, innerException) { }
    }
}