using System;
using System.Collections.Generic;
using System.Globalization;
using System.Linq;
using System.Text;
using System.Text.Json;
using DaatPhoenix.DaatLaw.AI.DataIntegrity.Models.AzureFunctions.Models;

namespace DaatPhoenix.DataLaw.DataIntegrity.Orchestration
{
	/// <summary>
	/// Produces a retrieval-friendly representation of direct Video Indexer output.
	/// It deliberately excludes the Blob URL used to process the video.
	/// </summary>
	public static class VideoInsightsMarkdownGenerator
	{
		private static readonly TimeSpan EvidenceChunkDuration = TimeSpan.FromMinutes(1);

		public static string Generate(JsonElement index, VideoIndexerInput source)
		{
			JsonElement video = FirstVideo(index);
			JsonElement insights = GetProperty(video, "insights");
			string duration = DurationValue(index, video);
			string mediaType = NormalizedMediaType(source.MediaType);
			var markdown = new StringBuilder();
			AppendMetadataComment(markdown, source);
			markdown.AppendLine($"# {char.ToUpperInvariant(mediaType[0])}{mediaType[1..]} analysis");
			markdown.AppendLine();
			markdown.AppendLine("## Source");
			markdown.AppendLine();
			markdown.AppendLine($"- File name: {Text(source.Filename)}");
			if (!string.IsNullOrWhiteSpace(duration))
			{
				markdown.AppendLine("- Duration (seconds): " + Text(duration));
			}
			markdown.AppendLine($"- Note: This is machine-derived metadata. Time ranges refer to the original {mediaType}; the original source remains authoritative.");

			AppendEvidenceChunks(markdown, CollectTimelineEvents(insights), source, mediaType, VideoDuration(duration));

			return markdown.ToString().TrimEnd();
		}

		private static List<TimelineEvent> CollectTimelineEvents(JsonElement insights)
		{
			var events = new List<TimelineEvent>();
			int sequence = 0;
			CollectTranscriptEvents(events, GetProperty(insights, "transcript"), ref sequence);
			CollectEvidenceEvents(events, GetProperty(insights, "ocr"), "OCR", "Text", ref sequence);
			CollectRangeEvents(events, GetProperty(insights, "scenes"), "Scene", ref sequence);
			CollectRangeEvents(events, GetProperty(insights, "shots"), "Shot", ref sequence);
			CollectEvidenceEvents(events, GetProperty(insights, "labels"), "Label", "Label", ref sequence);
			CollectEvidenceEvents(events, GetProperty(insights, "keywords"), "Keyword", "Keyword", ref sequence);
			CollectEvidenceEvents(events, GetProperty(insights, "objects"), "Object", "Object", ref sequence);
			CollectEvidenceEvents(events, GetProperty(insights, "brands"), "Brand", "Brand", ref sequence);
			CollectEvidenceEvents(events, GetProperty(insights, "namedEntities"), "Named entity", "Named entity", ref sequence);
			CollectEvidenceEvents(events, GetProperty(insights, "audioEffects"), "Audio effect", "Audio effect", ref sequence);
			CollectEvidenceEvents(events, GetProperty(insights, "topics"), "Topic", "Topic", ref sequence);
			CollectEvidenceEvents(events, GetProperty(insights, "sentiments"), "Sentiment", "Sentiment", ref sequence);
			CollectEvidenceEvents(events, GetProperty(insights, "emotions"), "Emotion", "Emotion", ref sequence);
			return events
				.OrderBy(item => item.SortStart)
				.ThenBy(item => item.SortEnd)
				.ThenBy(item => EventTypeOrder(item.Type))
				.ThenBy(item => item.Sequence)
				.ToList();
		}

		private static void AppendEvidenceChunks(
			StringBuilder markdown,
			IReadOnlyCollection<TimelineEvent> events,
			VideoIndexerInput source,
			string mediaType,
			TimeSpan? videoDuration)
		{
			if (events.Count == 0)
			{
				return;
			}
			markdown.AppendLine();
			markdown.AppendLine("## Evidence chunks");
			markdown.AppendLine();
			TimeSpan? effectiveDuration = videoDuration ?? TimelineEnd(events);

			var chunks = events
				.Where(item => item.SortStart != TimeSpan.MaxValue)
				.GroupBy(item => (int)(item.SortStart.TotalSeconds / EvidenceChunkDuration.TotalSeconds))
				.OrderBy(group => group.Key)
				.Select(group => new EvidenceChunk(
					group.Key,
					TimeSpan.FromSeconds(group.Key * EvidenceChunkDuration.TotalSeconds),
					group.ToList()))
				.ToList();
			var untimed = events.Where(item => item.SortStart == TimeSpan.MaxValue).ToList();
			if (untimed.Count > 0)
			{
				chunks.Add(new EvidenceChunk(null, null, untimed));
			}

			for (int index = 0; index < chunks.Count; index++)
			{
				EvidenceChunk chunk = chunks[index];
				TimeSpan? chunkEnd = chunk.Start is null
					? null
					: ChunkEnd(chunk, chunks, effectiveDuration);
				AppendEvidenceChunk(markdown, chunk.Events, source, mediaType, index + 1, chunk.Start, chunkEnd);
			}
		}

		private static void AppendEvidenceChunk(
			StringBuilder markdown,
			IReadOnlyCollection<TimelineEvent> events,
			VideoIndexerInput source,
			string mediaType,
			int sequence,
			TimeSpan? chunkStart,
			TimeSpan? chunkEnd)
		{
			string timeRange = chunkStart is null || chunkEnd is null
				? "Unavailable"
				: $"{FormatTimestamp(chunkStart.Value)}–{FormatTimestamp(chunkEnd.Value)}";
			var speakers = DistinctContents(events.Where(item => item.Type == "Transcript" && !string.IsNullOrWhiteSpace(item.Speaker))
				.Select(item => SpeakerLabel(source, item.Speaker!)));
			var keywords = DistinctContents(events.Where(item => item.Type == "Keyword").Select(item => item.Content));
			var topics = DistinctContents(events.Where(item => item.Type == "Topic").Select(item => item.Content));
			var sentiments = DistinctContents(events.Where(item => item.Type == "Sentiment").Select(item => item.Content));
			var emotions = DistinctContents(events.Where(item => item.Type == "Emotion").Select(item => item.Content));
			var labels = DistinctContents(events.Where(item => item.Type == "Label").Select(item => item.Content), 25);
			var contentEvents = events.Where(item => item.Type is "Transcript" or "OCR").ToList();
			var observations = events.Where(item => item.Type is "Scene" or "Shot" or "Object" or "Brand" or "Named entity" or "Audio effect").ToList();

			markdown.AppendLine($"### {mediaType}-{sequence:D4}");
			markdown.AppendLine();
			markdown.AppendLine($"- Source type: {mediaType}");
			markdown.AppendLine($"- File name: {Text(source.Filename)}");
			markdown.AppendLine($"- Time range: {timeRange}");
			AppendVisibleMetadata(markdown, source.Metadata);
			AppendMetadata(markdown, "Speakers", speakers);
			AppendMetadata(markdown, "Keywords", keywords);
			markdown.AppendLine();
			markdown.AppendLine("#### Content");
			markdown.AppendLine();
			if (contentEvents.Count == 0)
			{
				markdown.AppendLine("_No transcript or OCR content was detected in this time range._");
			}
			else
			{
				foreach (TimelineEvent item in contentEvents)
				{
					string speaker = string.IsNullOrWhiteSpace(item.Speaker) ? string.Empty : $"{SpeakerLabel(source, item.Speaker)}: ";
					markdown.AppendLine($"- [{DisplayRange(item)}] {speaker}{Text(item.Content)}");
				}
			}

			if (observations.Count > 0)
			{
				markdown.AppendLine();
				markdown.AppendLine("#### Observations");
				markdown.AppendLine();
				foreach (TimelineEvent item in observations)
				{
					markdown.AppendLine($"- [{DisplayRange(item)}] {item.Type}: {Text(item.Content)}");
				}
			}

			if (labels.Count > 0 || topics.Count > 0 || sentiments.Count > 0 || emotions.Count > 0)
			{
				markdown.AppendLine();
				markdown.AppendLine("#### Retrieval metadata");
				markdown.AppendLine();
				AppendMetadata(markdown, "Labels (metadata only)", labels);
				AppendMetadata(markdown, "Topics (metadata only)", topics);
				AppendMetadata(markdown, "Machine-inferred sentiment (metadata only)", sentiments);
				AppendMetadata(markdown, "Machine-inferred emotion (metadata only)", emotions);
			}
			markdown.AppendLine();
		}

		private static IReadOnlyCollection<string> DistinctContents(IEnumerable<string> values, int maximum = int.MaxValue) =>
			values
				.Where(value => !string.IsNullOrWhiteSpace(value))
				.Select(Text)
				.Distinct(StringComparer.OrdinalIgnoreCase)
				.Take(maximum)
				.ToList();

		private static void AppendMetadata(StringBuilder markdown, string name, IReadOnlyCollection<string> values)
		{
			if (values.Count > 0)
			{
				markdown.AppendLine($"- {name}: {string.Join(", ", values)}");
			}
		}

		private static string DisplayRange(TimelineEvent item) =>
			item.SortStart == TimeSpan.MaxValue ? "time unavailable" :
				$"{Text(item.Start)}–{Text(string.IsNullOrWhiteSpace(item.End) ? item.Start : item.End)}";

		private static string FormatTimestamp(TimeSpan timestamp) =>
			timestamp.ToString(@"hh\:mm\:ss\.fff", CultureInfo.InvariantCulture);

		private static string SpeakerLabel(VideoIndexerInput source, string speakerId)
		{
			string normalizedId = Text(speakerId);
			string defaultLabel = $"Speaker {normalizedId}";
			if (source.SpeakerNames is null)
			{
				return defaultLabel;
			}

			if (!source.SpeakerNames.TryGetValue(normalizedId, out string? name))
			{
				source.SpeakerNames.TryGetValue(defaultLabel, out name);
			}
			return string.IsNullOrWhiteSpace(name)
				? defaultLabel
				: $"{Text(name)} ({defaultLabel})";
		}

		private static TimeSpan ChunkEnd(
			EvidenceChunk chunk,
			IReadOnlyCollection<EvidenceChunk> allChunks,
			TimeSpan? videoDuration)
		{
			TimeSpan regularEnd = chunk.Start!.Value + EvidenceChunkDuration;
			bool isLastTimedChunk = !allChunks.Any(candidate =>
				candidate.Bucket is int bucket && bucket > chunk.Bucket);
			return isLastTimedChunk && videoDuration is TimeSpan duration && duration > chunk.Start && duration < regularEnd
				? duration
				: regularEnd;
		}

		private static string DurationValue(JsonElement index, JsonElement video)
		{
			string rootDuration = FirstString(index, "durationInSeconds", "duration");
			return string.IsNullOrWhiteSpace(rootDuration)
				? FirstString(video, "durationInSeconds", "duration")
				: rootDuration;
		}

		private static TimeSpan? VideoDuration(string value)
		{
			if (double.TryParse(value, NumberStyles.Float, CultureInfo.InvariantCulture, out double seconds) && seconds > 0)
			{
				return TimeSpan.FromSeconds(seconds);
			}

			return TimeSpan.TryParse(value, CultureInfo.InvariantCulture, out TimeSpan duration) && duration > TimeSpan.Zero
				? duration
				: null;
		}

		private static TimeSpan? TimelineEnd(IEnumerable<TimelineEvent> events)
		{
			var endpoints = events
				.Where(item => item.SortStart != TimeSpan.MaxValue)
				.Select(item => item.SortEnd == TimeSpan.MaxValue ? item.SortStart : item.SortEnd)
				.ToList();
			return endpoints.Count == 0 ? null : endpoints.Max();
		}

		private static void CollectTranscriptEvents(List<TimelineEvent> events, JsonElement items, ref int sequence)
		{
			if (items.ValueKind != JsonValueKind.Array)
			{
				return;
			}
			foreach (JsonElement item in items.EnumerateArray())
			{
				string content = FirstString(item, "text", "name");
				JsonElement instances = GetProperty(item, "instances");
				if (instances.ValueKind == JsonValueKind.Array && instances.GetArrayLength() > 0)
				{
					foreach (JsonElement instance in instances.EnumerateArray())
					{
						string speaker = FirstString(instance, "speakerId");
						AddTimelineEvent(events, instance, "Transcript", content,
							string.IsNullOrWhiteSpace(speaker) ? FirstString(item, "speakerId") : speaker, ref sequence);
					}
				}
				else
				{
					AddTimelineEvent(events, item, "Transcript", content, FirstString(item, "speakerId"), ref sequence);
				}
			}
		}

		private static void CollectEvidenceEvents(
			List<TimelineEvent> events,
			JsonElement items,
			string type,
			string fallbackContent,
			ref int sequence)
		{
			if (items.ValueKind != JsonValueKind.Array)
			{
				return;
			}
			foreach (JsonElement item in items.EnumerateArray())
			{
				string content = FirstString(item, "text", "name", "description", "displayName", "type", "sentimentKey");
				content = string.IsNullOrWhiteSpace(content) ? fallbackContent : content;
				JsonElement instances = GetProperty(item, "instances");
				if (instances.ValueKind == JsonValueKind.Array && instances.GetArrayLength() > 0)
				{
					foreach (JsonElement instance in instances.EnumerateArray())
					{
						AddTimelineEvent(events, instance, type, content, null, ref sequence);
					}
				}
				else
				{
					AddTimelineEvent(events, item, type, content, null, ref sequence);
				}
			}
		}

		private static void CollectRangeEvents(
			List<TimelineEvent> events,
			JsonElement items,
			string type,
			ref int sequence)
		{
			if (items.ValueKind != JsonValueKind.Array)
			{
				return;
			}
			int rangeNumber = 0;
			foreach (JsonElement item in items.EnumerateArray())
			{
				rangeNumber++;
				string id = FirstString(item, "id", "name");
				string content = string.IsNullOrWhiteSpace(id) ? $"{type} {rangeNumber}" : $"{type} {id}";
				JsonElement instances = GetProperty(item, "instances");
				if (instances.ValueKind == JsonValueKind.Array && instances.GetArrayLength() > 0)
				{
					foreach (JsonElement instance in instances.EnumerateArray())
					{
						AddTimelineEvent(events, instance, type, content, null, ref sequence);
					}
				}
				else
				{
					AddTimelineEvent(events, item, type, content, null, ref sequence);
				}
			}
		}

		private static void AddTimelineEvent(
			List<TimelineEvent> events,
			JsonElement timing,
			string type,
			string content,
			string? speaker,
			ref int sequence)
		{
			string start = FirstString(timing, "start", "adjustedStart");
			string end = FirstString(timing, "end", "adjustedEnd");
			sequence++;
			events.Add(new TimelineEvent(
				start,
				end,
				type,
				content,
				speaker,
				sequence,
				ParseTimestamp(start),
				ParseTimestamp(end)));
		}

		private static TimeSpan ParseTimestamp(string value) =>
			TimeSpan.TryParse(value, CultureInfo.InvariantCulture, out TimeSpan timestamp)
				? timestamp
				: TimeSpan.MaxValue;

		private static int EventTypeOrder(string type) => type switch
		{
			"Scene" => 0,
			"Shot" => 1,
			"Transcript" => 2,
			"OCR" => 3,
			"Label" => 4,
			"Keyword" => 5,
			"Object" => 6,
			"Brand" => 7,
			"Named entity" => 8,
			"Audio effect" => 9,
			"Topic" => 10,
			"Sentiment" => 11,
			"Emotion" => 12,
			_ => 13,
		};

		private static string NormalizedMediaType(string? value) =>
			string.Equals(value, "audio", StringComparison.OrdinalIgnoreCase) ? "audio" : "video";

		private static JsonElement FirstVideo(JsonElement index)
		{
			JsonElement videos = GetProperty(index, "videos");
			return videos.ValueKind == JsonValueKind.Array && videos.GetArrayLength() > 0
				? videos[0]
				: index;
		}

		private static JsonElement GetProperty(JsonElement element, string name)
		{
			return element.ValueKind == JsonValueKind.Object && element.TryGetProperty(name, out JsonElement value)
				? value
				: default;
		}

		private static string FirstString(JsonElement element, params string[] names)
		{
			foreach (string name in names)
			{
				JsonElement value = GetProperty(element, name);
				if (value.ValueKind == JsonValueKind.String)
				{
					return value.GetString() ?? string.Empty;
				}
				if (value.ValueKind == JsonValueKind.Number)
				{
					return value.ToString();
				}
			}
			return string.Empty;
		}

		private static void AppendVisibleMetadata(StringBuilder markdown, ResultMetadata? metadata)
		{
			if (!string.IsNullOrWhiteSpace(metadata?.Date))
			{
				markdown.AppendLine($"- Date: {Text(metadata.Date)}");
			}
			if (!string.IsNullOrWhiteSpace(metadata?.Location))
			{
				markdown.AppendLine($"- Location: {Text(metadata.Location)}");
			}
			if (!string.IsNullOrWhiteSpace(metadata?.Description))
			{
				markdown.AppendLine($"- Description: {Text(metadata.Description)}");
			}
		}

		private static void AppendMetadataComment(StringBuilder markdown, VideoIndexerInput source)
		{
			var metadata = new Dictionary<string, string>
			{
				["sourceId"] = source.SourceId ?? string.Empty,
			};

			string json = JsonSerializer.Serialize(metadata)
				.Replace("--", "\\u002D\\u002D", StringComparison.Ordinal);
			markdown.AppendLine($"<!-- data-integrity-metadata: {json} -->");
		}

		private static string Text(string? value) => (value ?? string.Empty)
			.Replace("\r\n", " ", StringComparison.Ordinal)
			.Replace("\n", " ", StringComparison.Ordinal)
			.Replace("\r", " ", StringComparison.Ordinal)
			.Trim();

		private sealed record TimelineEvent(
			string Start,
			string End,
			string Type,
			string Content,
			string? Speaker,
			int Sequence,
			TimeSpan SortStart,
			TimeSpan SortEnd);

		private sealed record EvidenceChunk(
			int? Bucket,
			TimeSpan? Start,
			IReadOnlyCollection<TimelineEvent> Events);
	}
}
