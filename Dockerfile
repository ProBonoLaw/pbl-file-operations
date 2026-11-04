FROM mcr.microsoft.com/dotnet/sdk:10.0 AS build
WORKDIR /source
COPY NuGet.Config ./
COPY src/FileOperations/FileOperations.csproj src/FileOperations/
COPY src/HttpOrchestration/HttpOrchestration.csproj src/HttpOrchestration/
COPY src/DataIntegrityService/DataIntegrityService.csproj src/DataIntegrityService/
COPY src/DataIntegrity/DataIntegrity.csproj src/DataIntegrity/
RUN dotnet restore src/FileOperations/FileOperations.csproj
COPY src/FileOperations/ src/FileOperations/
COPY src/HttpOrchestration/ src/HttpOrchestration/
COPY src/DataIntegrityService/ src/DataIntegrityService/
COPY src/DataIntegrity/ src/DataIntegrity/
RUN dotnet publish src/FileOperations/FileOperations.csproj -c Release --no-restore -o /app

FROM mcr.microsoft.com/dotnet/aspnet:10.0
RUN apt-get update && apt-get install -y --no-install-recommends libreoffice-writer libreoffice-impress libreoffice-calc poppler-utils qpdf fonts-liberation fonts-crosextra-carlito fonts-crosextra-caladea \
    && rm -rf /var/lib/apt/lists/*
WORKDIR /app
COPY --from=build /app .
ENV ASPNETCORE_URLS=http://+:8080
EXPOSE 8080
USER $APP_UID
ENTRYPOINT ["dotnet", "FileOperations.dll"]
